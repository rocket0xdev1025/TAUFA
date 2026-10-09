/* Minpentai on Ethereum.
   - Status of the game contract (a UUPS proxy), the $TAUFA contract address and the creator fees.
   - The player's wallet: EIP-6963 discovery, window.ethereum as the fallback.
   - Once a season implementation is installed, the live game. It is decoded with abi.json (generated from the
     compiled contract by artifacts/verify/site/gen-abi.mjs) and handed to the page as a 'minpentai:chain' event.
   - Transactions: TAUFA approval, a dry run that turns the contract's errors into words, the send, the receipt.
   Plain JSON-RPC, no libraries. */
(() => {
'use strict';
let GAME = '0x54Be0f71ABCdCac8C321F60C4c1A754059d7616C';
const TAUFA = '0x44E8e5d61E27e51CD18FF068661A80F8cdedf3Ee';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const FEE_ESCROW = '0xAcefe251da006887dA41C063D06CC82A060824BA'; // Stockereum: creator fees wait here until claimed
const CREATOR = '0x559d2Ea694084046D72ea048CBA32a5c057a91b7';    // TAUFA's fee recipient, also the game owner
const DEAD = '0x000000000000000000000000000000000000dEaD';        // where TAUFA is burned
let RPCS = [
  'https://lb.drpc.live/ethereum/AhFFc_foCERVuckrokH_kjmC5dvHwNIR8byBLtu1AWF8',
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
];
let POLL = 15000;
// The local rehearsal (artifacts/verify/site) points the page at an anvil mainnet fork. Honoured on localhost only,
// so a link can never send a visitor of the real site to another node or contract.
{
  const q = new URLSearchParams(location.search), h = location.hostname;
  if ((h === 'localhost' || h === '127.0.0.1') && q.get('rpc')){
    RPCS = [q.get('rpc')];
    if (/^0x[0-9a-fA-F]{40}$/.test(q.get('game') || '')) GAME = q.get('game');
    POLL = 1000 * (+q.get('poll') || 3);
  }
}
// index.html?practice: the page keeps the practice round while a season runs (index.html reads the same flag)
const PRACTICE = new URLSearchParams(location.search).has('practice');
const switchHref = practice => { const q = new URLSearchParams(location.search); if (practice) q.set('practice', ''); else q.delete('practice'); const s = q.toString().replace(/practice=(&|$)/, 'practice$1'); return location.pathname + (s ? '?' + s : ''); };
const SCAN = 'https://etherscan.io';
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // EIP-1967
// read before abi.json is needed: they answer on the bootstrap too, or are ERC-20 / Stockereum calls
const SEL = { owner: '0x8da5cb5b', version: '0x54fd4d50', balanceOf: '0x70a08231', allowance: '0xdd62ed3e', claimable: '0xd4570c1c', approve: '0x095ea7b3' };
// maps() returns uint256[2][8]; the order is MinpentaiViews.maps()
const MAPS = ['healthy', 'cracked', 'shielded', 'posts', 'sweep', 'postSweep', 'settleCrack', 'settleRuin'];

const $ = id => document.getElementById(id);
const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const scan = a => `${SCAN}/address/${a}`;
const arg = a => a.slice(2).toLowerCase().padStart(64, '0');
const store = {
  get(k){ try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v){ try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} },
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- JSON-RPC: one batch per refresh, failing over to the next endpoint ---------- */
let at = 0;
async function post(url, body){
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function batch(calls){
  if (!calls.length) return [];
  const body = calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }));
  let last;
  for (let k = 0; k < RPCS.length; k++){
    const i = (at + k) % RPCS.length;
    try {
      const j = await post(RPCS[i], body);
      if (!Array.isArray(j)) throw new Error((j && j.error && j.error.message) || 'bad reply');
      at = i;
      const byId = []; for (const r of j) byId[r.id] = r;
      return calls.map((_, id) => byId[id] || { error: { message: 'missing' } });
    } catch (e) { last = e; }
  }
  throw last;
}
async function rpc(method, params){
  const [r] = await batch([[method, params]]);
  if (r.error) throw rpcError(r.error);
  return r.result;
}
const ethCall = (data, to = GAME) => ['eth_call', [{ to, data }, 'latest']];
const word = (hex, k = 0) => (hex || '0x').slice(2 + 64 * k, 66 + 64 * k);
const big = hex => BigInt('0x' + (word(hex) || '0'));
const addr = hex => '0x' + word(hex).slice(24);
function utf8(h){ const b = h.match(/../g) || []; return new TextDecoder().decode(Uint8Array.from(b, x => parseInt(x, 16))); }
function str(hex){
  const h = (hex || '0x').slice(2); if (h.length < 128) return '';
  const off = parseInt(h.slice(0, 64), 16) * 2, n = parseInt(h.slice(off, off + 64), 16);
  return utf8(h.slice(off + 64, off + 64 + n * 2));
}
const toEth = wei => Number(wei) / 1e18;
function fmtEth(wei){
  const v = toEth(wei);
  return v === 0 ? '0' : v < 0.0001 ? '<0.0001' : v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}
function fmtTok(wei){
  const v = toEth(wei);
  return v === 0 ? '0' : v < 0.01 ? '<0.01' : v.toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 0 : 2 });
}
const utc = t => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
function dur(s){
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

/* ---------- ABI codec, driven by abi.json ---------- */
let ABI = null, abiLoading = null;
function parseT(p){
  const m = p.type.match(/^(.*)\[(\d*)\]$/);
  if (m) return { kind: 'array', len: m[2] === '' ? -1 : +m[2], of: parseT({ ...p, type: m[1] }) };
  if (p.type === 'tuple') return { kind: 'tuple', comps: p.components.map(c => ({ name: c.name, t: parseT(c) })) };
  return { kind: 'base', name: p.type };
}
const tuple = list => ({ kind: 'tuple', comps: list.map(p => ({ name: p.name, t: parseT(p) })) });
function loadAbi(){
  if (ABI) return Promise.resolve(ABI);
  if (!abiLoading) abiLoading = fetch('abi.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('abi.json ' + r.status); return r.json(); }).then(a => {
    for (const f of Object.values(a.functions)){ f.tin = tuple(f.inputs); f.tout = tuple(f.outputs); }
    for (const e of Object.values(a.events)){ e.tdata = tuple(e.inputs.filter(i => !i.indexed)); }
    for (const e of Object.values(a.errors)) e.tin = tuple(e.inputs);
    return (ABI = a);
  }).catch(e => { abiLoading = null; throw e; });
  return abiLoading;
}
const isDyn = t => t.kind === 'base' ? t.name === 'string' || t.name === 'bytes' : t.kind === 'array' ? t.len < 0 || isDyn(t.of) : t.comps.some(c => isDyn(c.t));
const headLen = t => isDyn(t) ? 32 : t.kind === 'array' ? t.len * headLen(t.of) : t.kind === 'tuple' ? t.comps.reduce((a, c) => a + headLen(c.t), 0) : 32;
const W = (h, at) => h.slice(at * 2, at * 2 + 64);
const U = (h, at) => BigInt('0x' + (W(h, at) || '0'));
// a value whose head word is at byte `at`; offsets of dynamic values count from `base`, the start of the enclosing tuple
function decAt(t, h, at, base){ return isDyn(t) ? decBody(t, h, base + Number(U(h, at))) : decBody(t, h, at); }
function decBody(t, h, at){
  if (t.kind === 'base'){
    const n = t.name, w = W(h, at);
    if (n === 'address') return '0x' + w.slice(24);
    if (n === 'bool') return BigInt('0x' + w) !== 0n;
    if (n.startsWith('uint')) return BigInt('0x' + w);
    if (n.startsWith('int')){ const v = BigInt('0x' + w); return v >= (1n << 255n) ? v - (1n << 256n) : v; }
    if (n === 'string' || n === 'bytes'){ const len = Number(U(h, at)), b = h.slice((at + 32) * 2, (at + 32 + len) * 2); return n === 'string' ? utf8(b) : '0x' + b; }
    return '0x' + w; // bytesN
  }
  if (t.kind === 'array'){
    let n = t.len, start = at;
    if (n < 0){ n = Number(U(h, at)); start = at + 32; }
    const step = headLen(t.of), out = [];
    for (let k = 0; k < n; k++) out.push(decAt(t.of, h, start + k * step, start));
    return out;
  }
  const o = []; let off = at;
  for (const c of t.comps){ const v = decAt(c.t, h, off, at); o.push(v); if (c.name) o[c.name] = v; off += headLen(c.t); }
  return o;
}
function enc(t, v){
  if (t.kind === 'base'){
    const n = t.name;
    if (n === 'address') return arg(v);
    if (n === 'bool') return (v ? 1n : 0n).toString(16).padStart(64, '0');
    if (/^u?int/.test(n)){ let b = BigInt(v); if (b < 0n) b += 1n << 256n; return b.toString(16).padStart(64, '0'); }
    if (/^bytes\d+$/.test(n)) return String(v).replace(/^0x/, '').padEnd(64, '0');
  }
  if (t.kind === 'tuple') return t.comps.map((c, k) => enc(c.t, v[c.name] !== undefined ? v[c.name] : v[k])).join('');
  if (t.kind === 'array' && t.len >= 0 && !isDyn(t.of)) return v.map(x => enc(t.of, x)).join('');
  throw new Error('chain.js: dynamic inputs are not used by the site');
}
function fn(name){ const f = ABI && ABI.functions[name]; if (!f) throw new Error('abi.json has no ' + name); return f; }
const calldata = (name, args = []) => { const f = fn(name); return f.selector + f.tin.comps.map((c, k) => enc(c.t, args[k])).join(''); };
function result(name, r){
  if (r.error) throw rpcError(r.error);
  return decBody(fn(name).tout, (r.result || '0x').slice(2), 0);
}
function decodeLog(l){
  const e = ABI && ABI.events[l.topics[0]]; if (!e) return null;
  const args = {}, data = (l.data || '0x').slice(2);
  const vals = decBody(e.tdata, data, 0);
  let ti = 1, di = 0;
  for (const p of e.inputs){
    if (p.indexed){ const t = parseT(p); const h = l.topics[ti++].slice(2); args[p.name] = t.kind === 'base' && !isDyn(t) ? decBody(t, h, 0) : '0x' + h; }
    else args[p.name] = vals[di++];
  }
  return { name: e.name, args, block: parseInt(l.blockNumber, 16), ts: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : 0, tx: l.transactionHash, key: l.transactionHash + ':' + parseInt(l.logIndex, 16) };
}

/* ---------- errors: revert data to words ---------- */
const FRIENDLY = {
  WrongPhase: 'Not possible in this phase of the season.',
  SettleFirst: 'The last bell is still being settled. Try again in a minute.',
  BadSite: 'Pick a lit plot: sigils go on the checkerboard.',
  Taken: 'That plot is taken.',
  SoldOut: 'Sold out: all 512 sites are standing.',
  BatchFull: 'The opening batch is full (128 sigils, 10 per wallet).',
  PriceTooHigh: 'The price moved. Try again.',
  NotYours: 'That is not yours.',
  BadPiece: 'A piece can’t go there.',
  TooFar: 'Must be within 16 cells of one of your sigils or posts.',
  ForeignPlot: 'That plot belongs to another player.',
  OwnPlotRule: 'In your own plot, leave a 1-cell gap around the block and fire outward.',
  BudgetFull: 'This bell’s strike is taken: 8 weapon cells per bell for the whole board.',
  RingFull: 'Too many moves are queued for this bell.',
  NotCracked: 'That sigil is not cracked.',
  NothingToClaim: 'Nothing to claim yet.',
  Frozen: 'The season is frozen: claims only.',
  NotEnded: 'The season has not ended yet.',
  Early: 'Too early.',
  Slippage: 'The price moved. Try again.',
  SendFailed: 'The payment could not be sent.',
  ERC20InsufficientBalance: 'Not enough TAUFA.',
  ERC20InsufficientAllowance: 'The TAUFA allowance is too low. Approve it and try again.',
};
function revertData(e, depth = 0){
  if (!e || depth > 5) return '';
  if (typeof e === 'string') return /^0x[0-9a-fA-F]{8}/.test(e) ? e : '';
  if (typeof e !== 'object') return '';
  for (const k of ['data', 'error', 'originalError', 'cause', 'info']){ const d = revertData(e[k], depth + 1); if (d) return d; }
  return '';
}
function reason(e){
  if (!e) return 'Something went wrong.';
  if (e.friendly) return e.message;
  if (e.code === 4001 || e.code === 'ACTION_REJECTED') return 'Cancelled in the wallet.';
  const d = revertData(e);
  if (d && ABI){
    const er = ABI.errors[d.slice(0, 10).toLowerCase()];
    if (er){
      if (er.name === 'Error'){ try { return decBody(er.tin, d.slice(10), 0)[0]; } catch (x) {} }
      return FRIENDLY[er.name] || er.name.replace(/([a-z])([A-Z])/g, '$1 $2') + '.';
    }
  }
  const m = (e.message || String(e)).replace(/^execution reverted:?\s*/i, '');
  return m.length > 140 ? m.slice(0, 140) + '…' : m || 'The transaction would fail.';
}
function rpcError(err){ const e = new Error(err.message || 'RPC error'); e.code = err.code; e.data = err.data; return e; }
const friendly = msg => Object.assign(new Error(msg), { friendly: true });

/* ---------- what the page shows ---------- */
const S = {
  block: 0, chainTime: 0, fetchedAt: 0, impl: '', owner: '', version: '', error: false, liveError: false,
  account: '', balance: null, taufa: null, allowance: null, wrongChain: false, busy: false,
  feesIn: null, feesWaiting: null, burned: null, live: null,
};
const now = () => S.chainTime ? S.chainTime + (Date.now() - S.fetchedAt) / 1000 : Date.now() / 1000;

let reading = false, readAgain = false;
async function read(){
  if (reading){ readAgain = true; return; }
  reading = true;
  try { await readOnce(); } catch (e) { console.warn('minpentai read', e); }
  finally { reading = false; if (readAgain){ readAgain = false; read(); } }
}
async function readOnce(){
  const acct = S.account;
  const calls = [['eth_getBlockByNumber', ['latest', false]], ['eth_getStorageAt', [GAME, IMPL_SLOT, 'latest']], ethCall(SEL.owner), ethCall(SEL.version),
    ethCall(SEL.balanceOf + arg(GAME), WETH), ethCall(SEL.claimable + arg(CREATOR) + arg(WETH), FEE_ESCROW), ethCall(SEL.balanceOf + arg(DEAD), TAUFA)];
  if (acct) calls.push(['eth_getBalance', [acct, 'latest']], ethCall(SEL.balanceOf + arg(acct), TAUFA), ethCall(SEL.allowance + arg(acct) + arg(GAME), TAUFA));
  let r;
  try { r = await batch(calls); } catch (e) { S.error = true; render(); emit(); return; }
  const blk = r[0].result;
  if (blk){ S.block = parseInt(blk.number, 16); S.chainTime = parseInt(blk.timestamp, 16); S.fetchedAt = Date.now(); }
  if (r[1].result) S.impl = addr(r[1].result);
  if (r[2].result) S.owner = addr(r[2].result);
  S.version = r[3].result ? str(r[3].result) : '';
  // TAUFA creator fees (WETH): already forwarded into the game contract, and still waiting at Stockereum
  if (r[4].result && r[4].result.length >= 66) S.feesIn = big(r[4].result);
  if (r[5].result && r[5].result.length >= 66) S.feesWaiting = big(r[5].result);
  if (r[6].result && r[6].result.length >= 66) S.burned = big(r[6].result);
  if (acct && acct === S.account){
    if (r[7].result) S.balance = BigInt(r[7].result);
    if (r[8].result && r[8].result.length >= 66) S.taufa = big(r[8].result);
    if (r[9].result && r[9].result.length >= 66) S.allowance = big(r[9].result);
  }
  // the block came back but the proxy did not answer: say so instead of showing "no season"
  S.error = !r[1].result || !r[2].result;
  // a season implementation is installed when version() no longer says bootstrap
  if (!S.error && S.version && !/bootstrap/i.test(S.version)){
    try { await readSeason(acct); S.liveError = false; } catch (e) { S.liveError = true; console.warn('minpentai season read', e); }
  } else if (!S.error) S.live = null; // a failed read keeps the last season on screen
  render(); emit();
}

/* the season: globals, maps, owners and board in one batch; names, settlement and the event log after it */
let boardHex = '', boardSeason = -1;
const names = new Map(); let namesSeason = -1;
const LOG = { season: -1, to: 0, list: [], keys: new Set(), initial: true };
function bits512(pair){
  const out = new Uint8Array(512), w = [BigInt(pair[0]), BigInt(pair[1])];
  for (let s = 0; s < 512; s++) out[s] = Number((w[s >> 8] >> BigInt(s & 255)) & 1n);
  return out;
}
function hexBytes(h){ const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }
// Plane256 layout (src/core/Plane256.sol wordBit): q = 2 (y & 1) + (x & 1), r = y >> 1, word 64 q + (r & 63), bit 128 (r >> 6) + (x >> 1)
function decodeBoard(hex){
  const h = hex.slice(2), B = [];
  for (let k = 0; k < 256; k++) B.push(hexBytes(h.substr(k * 64, 64)));
  const cells = new Uint8Array(65536);
  for (let y = 0; y < 256; y++){
    const r = y >> 1, q2 = (y & 1) << 1, wr = r & 63, lane = (r >> 6) << 7;
    for (let x = 0; x < 256; x++){
      const b = B[((q2 | (x & 1)) << 6) | wr], bit = lane + (x >> 1);
      cells[(y << 8) | x] = (b[31 - (bit >> 3)] >> (bit & 7)) & 1;
    }
  }
  return cells;
}
async function readSeason(acct){
  await loadAbi();
  const c = (name, args) => ethCall(calldata(name, args));
  const calls = [c('globals'), c('maps'), c('plotOwners'), c('boardWords')];
  if (acct) calls.push(c('playerInfo', [acct]));
  const r = await batch(calls);
  const g = result('globals', r[0])[0];
  const sid = Number(g.seasonId);
  const mp = result('maps', r[1])[0], maps = {};
  MAPS.forEach((n, k) => { maps[n] = bits512(mp[k]); });
  const ow = result('plotOwners', r[2])[0], owners = new Uint16Array(1024);
  for (let p = 0; p < 1024; p++) owners[p] = Number((ow[p >> 4] >> BigInt((p & 15) << 4)) & 0xffffn);
  let board = null;
  if (r[3].error) throw rpcError(r[3].error);
  if (r[3].result !== boardHex || sid !== boardSeason){ boardHex = r[3].result; boardSeason = sid; board = decodeBoard(boardHex); }
  let me = null;
  if (acct && r[4]){ const p = result('playerInfo', r[4]); me = { idx: Number(p.idx), earning: Number(p.earning), weightHalves: Number(p.weightHalves), freeRams: Number(p.freeRams), freeUntil: Number(p.freeUntil), batchBought: Number(p.batchBought), bought: Number(p.bought), pending: p.pending }; }

  // addresses of the owners on the board, and what an ended season still owes this wallet
  if (namesSeason !== sid){ names.clear(); namesSeason = sid; }
  const want = new Set();
  for (let p = 0; p < 1024; p++) if (owners[p] && !names.has(owners[p])) want.add(owners[p]);
  const ask = [...want].slice(0, 200);
  const ph = Number(g.phase), turn = Number(g.turn);
  const settleSeason = ph >= 4 ? sid : sid - 1;
  const calls2 = ask.map(i => c('playerAt', [sid, i]));
  // the coming bell (turn + 1), announced: its Arctic rams and rocks, and every move queued for it
  const ahead = ph >= 1 && ph <= 3 && turn < 84;
  if (ahead) calls2.push(c('weatherOf', [turn + 1, g.dronesNext]), c('records'));
  if (acct && settleSeason >= 1) calls2.push(c('pendingSettlement', [settleSeason, acct]));
  const r2 = await batch(calls2);
  ask.forEach((i, k) => { if (!r2[k].error) names.set(i, result('playerAt', r2[k])[0].toLowerCase()); });
  let n = ask.length, forecast = null;
  if (ahead){
    const w = r2[n++], q = r2[n++];
    if (!w.error && !q.error){
      const [rams, rocks] = result('weatherOf', w), [stamps, toggles] = result('records', q);
      const triples = (a, f) => { const o = []; for (let k = 0; k + 2 < a.length; k += 3) o.push(f(Number(a[k]), Number(a[k + 1]), Number(a[k + 2]))); return o; };
      forecast = {
        bell: turn + 1,
        rams: triples(rams, (y, x, pat) => ({ y, x, pat })),
        rocks: triples(rocks, (y, x, missing) => ({ y, x, missing })),
        stamps: triples(stamps, (y, x, pat) => ({ y, x, pat })),
        toggles: toggles.reduce((o, v, k) => (k & 1 ? o[o.length - 1].x = Number(v) : o.push({ y: Number(v), x: 0 }), o), []),
      };
    }
  }
  let settle = null;
  if (acct && settleSeason >= 1){ const v = r2[n]; if (v && !v.error) settle = { season: settleSeason, amount: result('pendingSettlement', v)[0] }; }

  const fresh = await scanLog(sid, Number(g.openAt));
  S.live = { g, maps, owners, board, names, me, settle, forecast, log: LOG.list, fresh, initial: LOG.initial, ...tally(acct, Number(g.openAt)) };
  LOG.initial = false;
}
/* the game's events this season, scanned incrementally; dRPC returns blockTimestamp, others get it from the blocks */
async function logsRange(a, b){
  try { return await rpc('eth_getLogs', [{ address: GAME, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }]); }
  catch (e){ if (b - a < 2000) throw e; const m = (a + b) >> 1; return [...await logsRange(a, m), ...await logsRange(m + 1, b)]; }
}
async function scanLog(sid, openAt){
  if (LOG.season !== sid){ LOG.season = sid; LOG.to = 0; LOG.list = []; LOG.keys = new Set(); LOG.initial = true; }
  const head = S.block;
  // from two days before the season opened (scheduling, opening batch), at most 150,000 blocks back
  const from = LOG.to ? Math.max(0, LOG.to - 2) : Math.max(0, head - Math.min(150000, Math.ceil((now() - Math.min(openAt || now(), now()) + 2 * 86400) / 12)));
  if (from > head) return [];
  const raw = await logsRange(from, head);
  const fresh = [];
  for (const l of raw){
    const e = decodeLog(l); if (!e || LOG.keys.has(e.key)) continue;
    if (e.args.season !== undefined && Number(e.args.season) !== sid) continue;
    LOG.keys.add(e.key); fresh.push(e);
  }
  const need = [...new Set(fresh.filter(e => !e.ts).map(e => e.block))].slice(0, 100);
  if (need.length){
    const r = await batch(need.map(b => ['eth_getBlockByNumber', ['0x' + b.toString(16), false]]));
    const ts = new Map(); need.forEach((b, k) => { if (r[k].result) ts.set(b, parseInt(r[k].result.timestamp, 16)); });
    for (const e of fresh) if (!e.ts) e.ts = ts.get(e.block) || Math.round(S.chainTime - (head - e.block) * 12);
  }
  fresh.sort((a, b) => a.block - b.block);
  LOG.list.push(...fresh);
  LOG.to = head;
  return fresh;
}
/* what the page needs from the log: your payments and claims, the price curve and the last 24 h of tribute */
function tally(acct, openAt){
  let paid = 0n, claimed = 0n, trib24 = 0n, harvested = 0n;
  const priceHist = [], since = now() - 86400;
  for (const e of LOG.list){
    const a = e.args, mine = acct && a.player && a.player.toLowerCase() === acct;
    if (e.name === 'SigilBought'){
      if (mine) paid += a.price;
      if (!a.batch && e.ts >= since) trib24 += a.price * 4500n / 10000n;
      if (openAt) priceHist.push([Math.max(0, (e.ts - openAt) / 86400), toEth(a.price)]);
    } else if (e.name === 'TributeClaimed' && mine) claimed += a.amount;
    else if (e.name === 'FeesHarvested'){ harvested += a.amount; if (e.ts >= since) trib24 += a.toTribute; }
    else if (e.name === 'HeldReleased' && e.ts >= since) trib24 += a.amount;
  }
  return { paid, claimed, trib24, priceHist, harvested };
}
function emit(){
  dispatchEvent(new CustomEvent('minpentai:chain', { detail: {
    block: S.block, error: S.error, now, account: S.account, balance: S.balance, taufa: S.taufa, burned: S.burned, live: S.live,
  } }));
  if (S.live) S.live.fresh = [];
}

/* ---------- the panel, the wallet button and the announcement bar ---------- */
const PHASE = ['scheduled', 'opening batch', 'open', 'siege weekend', 'ended', 'frozen'];
function render(){
  const nav = $('walletNav'), btn = $('walletBtn');
  if (nav){
    nav.classList.toggle('on', !!S.account);
    nav.querySelector('.wl').textContent = S.account ? short(S.account) : S.busy ? 'Connecting…' : 'Connect wallet';
    nav.querySelector('.ws').textContent = S.account ? S.account.slice(0, 6) : S.busy ? '…' : 'Connect';
    nav.title = S.account ? 'Connected: ' + S.account : 'Connect an Ethereum wallet';
  }
  if (btn) btn.querySelector('span').textContent = S.account ? 'Disconnect' : S.busy ? 'Connecting…' : 'Connect wallet';
  if (!$('chainCard')) return;
  const L = S.live, g = L && L.g;
  $('chBlock').textContent = S.block ? 'block ' + S.block.toLocaleString('en-US') : S.error ? 'offline' : 'connecting…';
  $('chainCard').classList.toggle('ok', !!S.block && !S.error && !S.liveError);
  $('chState').textContent = S.error ? (S.block ? 'Can’t read the game contract right now. Retrying.' : 'Can’t reach Ethereum right now. Retrying.')
    : !S.block ? 'Reading Ethereum…'
    : S.liveError ? 'The season contract is installed, but this page can’t read it right now. Retrying.'
    : g && Number(g.seasonId) > 0 ? (PRACTICE ? 'You are in the practice round: simulated players, fake ETH. On chain: ' + seasonLine(g).replace(/ (Everything|The board and every number) on this page.*$/, '') : seasonLine(g))
    : g ? 'The season contract is installed. No season is scheduled yet. The board below is a practice round: simulated players, fake ETH.'
    : 'No season is open on chain yet. The board below is a practice round: simulated players, fake ETH.';
  const code = $('chCode');
  if (S.impl){ code.href = scan(S.impl); code.textContent = (S.version ? S.version.replace(/-(bootstrap|season)$/, ' · $1') : short(S.impl)) + ' ↗'; }
  const own = $('chOwner');
  if (S.owner){ own.href = scan(S.owner); own.textContent = short(S.owner) + ' ↗'; }
  $('chWallet').textContent = !S.account ? 'not connected'
    : `${short(S.account)} · ${S.balance == null ? '…' : fmtEth(S.balance) + ' ETH'}${S.wrongChain ? ' · switch to Ethereum' : ''}`;
  $('chWallet').classList.toggle('red', S.wrongChain);
  $('chTaufa').textContent = !S.account ? '–' : S.taufa == null ? '…' : fmtTok(S.taufa) + ' TAUFA';
  if (S.feesIn != null){
    // once fees are harvested the proxy holds ETH, not WETH: count what was recognized (an all-time counter in
    // globals when the contract has one, else the harvests in this season's log) plus the WETH still waiting in it
    const rec = g ? (g.feesIn !== undefined ? g.feesIn : S.live.harvested) : 0n;
    const v = fmtEth(S.feesIn + rec) + (rec > 0n ? ' ETH' : ' WETH');
    $('chFeesIn').textContent = v;
    document.querySelectorAll('[data-fees-in]').forEach(n => { n.textContent = v; });
  }
  if (S.feesWaiting != null) $('chFeesWait').textContent = fmtEth(S.feesWaiting) + ' WETH';
  // while a season is on chain: a way into the practice round and back
  const alt = $('chAlt');
  if (alt){
    const on = !!(g && Number(g.seasonId) > 0);
    alt.hidden = !on;
    if (on && alt.dataset.mode !== String(PRACTICE)){
      alt.dataset.mode = String(PRACTICE); alt.textContent = '';
      const a = el('a', '', PRACTICE ? '← Back to the live board' : 'Practice round, no wallet →'); a.href = switchHref(!PRACTICE); alt.append(a);
    }
  }
  notice();
}
function seasonLine(g){
  const sid = Number(g.seasonId), ph = Number(g.phase), t = now();
  if (ph === 0) return `Season ${sid} is scheduled: it opens ${utc(Number(g.openAt))}, in ${dur(Number(g.openAt) - t)}. Everything on this page is read from Ethereum.`;
  if (ph >= 4) return `Season ${sid} ${ph === 4 ? 'has ended' : 'is frozen'}. Claim your share with the Claim button. Everything on this page is read from Ethereum.`;
  return `Season ${sid} · ${PHASE[ph]} · bell ${Number(g.turn)} of 84. The board and every number on this page are read from Ethereum.`;
}
/* the bar at the top: Phase 1 by default, then whatever the season says; closing one does not hide the next */
let noticeKey = '';
function notice(){
  const bar = $('notice'); if (!bar) return;
  const g = S.live && S.live.g, sid = g ? Number(g.seasonId) : 0, ph = g ? Number(g.phase) : -1;
  if (!sid) return; // keep the Phase 1 text in the page
  const key = `s${sid}p${ph}${PRACTICE ? 'x' : ''}`;
  if (key === noticeKey) return;
  noticeKey = key;
  const open = Number(g.openAt), tag = bar.querySelector('.ntag'), text = bar.querySelector('.ntag + span');
  if (PRACTICE){
    tag.textContent = 'Practice round';
    const is = ['scheduled', 'in its opening batch', 'open', 'in its siege weekend', 'over', 'frozen'][ph] || 'running';
    text.textContent = `Simulated players and fake ETH, nothing here touches the chain. Season ${sid} is ${is} on Ethereum. `;
    const a = el('a', '', 'Back to the live board →'); a.href = switchHref(false); text.append(a);
    bar.hidden = false; dispatchEvent(new Event('resize'));
    return;
  }
  const msg = ph === 0 ? [`Season ${sid} is scheduled`, `It opens ${utc(open)}. The first two hours are the opening batch: one floor price for everyone, at most 128 sigils and 10 per wallet. Later sigils pay earlier ones, and you can lose what you pay.`]
    : ph === 1 ? [`Season ${sid} is open`, `Opening batch until ${utc(open + 7200).slice(11)}: one floor price for everyone, at most 128 sigils and 10 per wallet. Later sigils pay earlier ones, and you can lose what you pay.`]
    : ph === 2 ? [`Season ${sid} is live`, `Plant a sigil on Ethereum. 45% of every later sigil goes to the sigils standing, and the TAUFA creator-fee pool pays them about 7.5% a day. Planting closes on day 12, then the siege weekend. You can lose what you pay.`]
    : ph === 3 ? [`Siege weekend`, `Season ${sid}: no new sigils, no repairs, no shields. After the last bell, 90% of the war chest goes to what still stands.`]
    : ph === 4 ? [`Season ${sid} has ended`, `Standing sigils and ruins can claim their share of the war chest with the Claim button.`]
    : [`Season ${sid} is frozen`, `Claims only: every ledger is paid out by share. Use the Claim button.`];
  tag.textContent = msg[0]; text.textContent = msg[1];
  bar.hidden = store.get('mp.notice') === key;
  dispatchEvent(new Event('resize'));
}

function toast(msg, ms = 2600){
  const t = $('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- wallets: EIP-6963 discovery, window.ethereum as the fallback ---------- */
const found = [];
addEventListener('eip6963:announceProvider', e => {
  const d = e.detail;
  if (d && d.provider && d.info && !found.some(f => f.info.uuid === d.info.uuid)) found.push(d);
});
dispatchEvent(new Event('eip6963:requestProvider'));
const wallets = () => found.length ? found
  : window.ethereum ? [{ info: { uuid: 'injected', rdns: 'injected', name: 'Browser wallet', icon: '' }, provider: window.ethereum }] : [];
// the EIP-6963 uuid changes on every page load; rdns (e.g. io.metamask) is what stays the same
const walletKey = w => w.info.rdns || w.info.name || 'injected';

let Wl = null;
function forget(){ S.balance = null; S.taufa = null; S.allowance = null; }
function hook(p){
  if (!p.on || p.__mp) return; p.__mp = true;
  p.on('accountsChanged', a => {
    if (!Wl || Wl.provider !== p) return;
    S.account = ((a && a[0]) || '').toLowerCase(); forget();
    if (!S.account){ Wl = null; store.set('mp.wallet', null); }
    render(); read();
  });
  p.on('chainChanged', () => { if (Wl && Wl.provider === p) checkChain(); });
}
async function checkChain(){
  try { S.wrongChain = parseInt(await Wl.provider.request({ method: 'eth_chainId' }), 16) !== 1; } catch (e) {}
  render();
}
async function switchChain(){
  try { await Wl.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }); } catch (e) {}
  await checkChain();
  if (S.wrongChain) throw friendly('Switch your wallet to Ethereum mainnet first.');
}
async function use(w, prompt){
  const accts = await w.provider.request({ method: prompt ? 'eth_requestAccounts' : 'eth_accounts' });
  if (!accts || !accts[0]) return false;
  Wl = w; S.account = accts[0].toLowerCase(); forget(); hook(w.provider); store.set('mp.wallet', walletKey(w));
  if (prompt){ try { if (parseInt(await w.provider.request({ method: 'eth_chainId' }), 16) !== 1) await switchChain(); } catch (e) {} }
  await checkChain(); read();
  return true;
}
let connecting = null;
async function attempt(w){
  closeSheet(); S.busy = true; render();
  try { if (await use(w, true)) toast('Wallet connected'); }
  catch (e){ toast(e && e.code === 4001 ? 'Connection cancelled' : 'Could not connect: ' + ((e && e.message) || e)); }
  finally { S.busy = false; render(); if (connecting){ connecting(!!S.account); connecting = null; } }
}
function disconnect(){
  const p = Wl && Wl.provider;
  Wl = null; S.account = ''; forget(); S.wrongChain = false; store.set('mp.wallet', null); render(); read();
  if (p) Promise.resolve().then(() => p.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })).catch(() => {});
}

/* the wallet list, the no-wallet note and the risk note reuse the page's modal sheet; dismissing one (backdrop,
   Cancel) runs its onDismiss, closing it on the way to the next step does not */
let onDismiss = null;
function sheet(build, dismissed){
  const m = $('modal'), s = $('sheet'); if (!m || !s) return;
  s.textContent = ''; build(s); m.classList.add('show');
  onDismiss = dismissed || null;
  m.onclick = e => { if (e.target === m) dismissSheet(); };
}
function closeSheet(){ const m = $('modal'); if (m && m.onclick){ m.classList.remove('show'); m.onclick = null; } onDismiss = null; }
function dismissSheet(){ const f = onDismiss; closeSheet(); if (f) f(); }
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
const stopConnecting = () => { if (connecting){ const f = connecting; connecting = null; f(false); } };
function pick(list){
  sheet(s => {
    s.append(el('h2', '', 'Connect a wallet'), el('p', '', 'Pick the wallet to use on Ethereum mainnet.'));
    const box = el('div', 'wlist');
    for (const w of list){
      const b = el('button', 'wopt'); b.type = 'button';
      if (/^data:image\//.test(w.info.icon || '')){ const i = el('img'); i.src = w.info.icon; i.alt = ''; b.append(i); }
      b.append(el('span', '', w.info.name || 'Wallet')); b.onclick = () => attempt(w); box.append(b);
    }
    const c = el('button', 'wclose', 'Cancel'); c.type = 'button'; c.onclick = dismissSheet;
    s.append(box, c);
  }, stopConnecting);
}
function noWallet(){
  const phone = matchMedia('(pointer: coarse)').matches;
  sheet(s => {
    s.append(el('h2', '', 'No wallet found'),
      el('p', '', phone ? 'Open this page in your wallet app’s browser to connect.' : 'Install a browser wallet that supports Ethereum, then reload this page.'));
    if (phone){
      const a = el('a', 'btn wgo'); a.href = 'https://metamask.app.link/dapp/' + location.host + location.pathname;
      a.append(el('span', '', 'Open in MetaMask')); s.append(a);
    }
    const c = el('button', 'wclose', 'Close'); c.type = 'button'; c.onclick = dismissSheet; s.append(c);
  }, stopConnecting);
}
function connect(){
  if (S.account) return disconnect();
  const list = wallets();
  if (!list.length) return noWallet();
  if (list.length === 1) return attempt(list[0]);
  pick(list);
}
/* connect from inside a game action; resolves true once a wallet is connected */
function ensureWallet(){
  if (S.account) return Promise.resolve(true);
  const list = wallets();
  stopConnecting();
  if (!list.length){ noWallet(); return Promise.resolve(false); }
  return new Promise(res => { connecting = res; if (list.length === 1) attempt(list[0]); else pick(list); });
}
/* shown once per browser before the first sigil: what the game does with the ETH, in the design's own words */
function confirmRisk(){
  if (store.get('mp.risk') === '1') return Promise.resolve(true);
  return new Promise(res => {
    sheet(s => {
      s.append(el('h2', '', 'Before you plant'),
        el('p', '', 'Later sigils pay earlier ones. If new sigils stop, tribute stops, and most late players lose money. You can lose everything you pay.'),
        el('p', '', 'The game contract is upgradeable by its owner. Nothing here is a promise of profit. Play only with ETH you can afford to lose.'));
      const row = el('div', 'plant'), ok = el('button', 'btn', ''), no = el('button', 'btn ghost', '');
      ok.type = no.type = 'button'; ok.append(el('span', '', 'I understand')); no.append(el('span', '', 'Not now'));
      ok.onclick = () => { store.set('mp.risk', '1'); closeSheet(); res(true); };
      no.onclick = dismissSheet;
      row.append(ok, no); s.append(row);
    }, () => res(false));
  });
}

/* ---------- transactions ---------- */
async function simulate(tx){
  try { await rpc('eth_call', [tx, 'latest']); }
  catch (e){ throw friendly(reason(e)); }
}
/* The gas limit is set here, with headroom: the game's gas depends on the block time (held creator fees drip once
   per block, the pool is sampled), so an estimate made against the latest block can come in about 20k short for the
   next one. Unused gas is not charged. */
async function send(tx){
  try {
    const est = BigInt(await rpc('eth_estimateGas', [tx]));
    tx = { ...tx, gas: '0x' + (est * 13n / 10n + 40000n).toString(16) };
  } catch (e){ throw friendly(reason(e)); }
  try { return await Wl.provider.request({ method: 'eth_sendTransaction', params: [tx] }); }
  catch (e){ throw friendly(reason(e)); }
}
async function waitTx(hash){
  for (let k = 0; k < 400; k++){
    const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r){ if (r.status === '0x1') return r; throw friendly('The transaction failed on chain.'); }
    await sleep(k < 10 ? 1500 : 3000);
  }
  throw friendly('Still waiting for the transaction. Check your wallet.');
}
let busyTx = false;
/* One game action: TAUFA approval if it burns TAUFA, a dry run, the wallet, the receipt, a refresh. */
async function tx(name, args = [], value = 0n, label = 'Done', taufaCost = 0n){
  if (busyTx) throw friendly('Another transaction is still pending.');
  if (!(await ensureWallet())) throw friendly('Connect a wallet first.');
  await loadAbi();
  busyTx = true;
  try {
    if (S.wrongChain) await switchChain();
    const from = S.account;
    if (taufaCost > 0n){
      const bal = big(await rpc('eth_call', [{ to: TAUFA, data: SEL.balanceOf + arg(from) }, 'latest']));
      if (bal < taufaCost) throw friendly(`Not enough TAUFA: this needs ${fmtTok(taufaCost)} TAUFA.`);
      const al = big(await rpc('eth_call', [{ to: TAUFA, data: SEL.allowance + arg(from) + arg(GAME) }, 'latest']));
      if (al < taufaCost){
        toast(`Step 1 of 2: approve ${fmtTok(taufaCost)} TAUFA in your wallet`, 8000);
        const h = await send({ from, to: TAUFA, data: SEL.approve + arg(GAME) + BigInt(taufaCost).toString(16).padStart(64, '0') });
        toast('Approving TAUFA: waiting for the block…', 30000);
        await waitTx(h);
      }
    }
    const t = { from, to: GAME, data: calldata(name, args) };
    if (value > 0n) t.value = '0x' + value.toString(16);
    await simulate(t);
    toast(taufaCost > 0n ? 'Step 2 of 2: confirm in your wallet' : 'Confirm in your wallet', 8000);
    const hash = await send(t);
    toast('Sent. Waiting for the block…', 30000);
    await waitTx(hash);
    toast(label);
    read();
    return hash;
  } finally { busyTx = false; }
}
async function call(name, args = []){
  await loadAbi();
  const r = await rpc('eth_call', [{ to: GAME, data: calldata(name, args) }, 'latest']);
  return decBody(fn(name).tout, r.slice(2), 0);
}
window.MinpentaiChain = { tx, call, reason, confirmRisk, ensureWallet, toast, account: () => S.account, short, scan, now, refresh: read };

/* ---------- start ---------- */
function start(){
  const nav = $('walletNav'), btn = $('walletBtn');
  if (nav) nav.onclick = () => S.account ? $('chainCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' }) : connect();
  if (btn) btn.onclick = connect;
  const gm = $('chGame'); if (gm){ gm.href = scan(GAME); gm.textContent = short(GAME) + ' ↗'; }
  document.querySelectorAll('[data-copy]').forEach(b => { b.onclick = () => copy(b.dataset.copy, b); });
  // the announcement bar: closing it is remembered per announcement; the field re-fits to the freed height
  const bar = $('notice');
  if (bar){
    if (store.get('mp.notice') === 'phase1'){ bar.hidden = true; dispatchEvent(new Event('resize')); }
    const x = bar.querySelector('.nx');
    if (x) x.onclick = () => { bar.hidden = true; store.set('mp.notice', noticeKey || 'phase1'); dispatchEvent(new Event('resize')); };
  }
  render(); read();
  setInterval(() => { if (!document.hidden) read(); }, POLL);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) read(); });
  // reconnect silently to the wallet used last time, once the wallets have announced themselves
  const last = store.get('mp.wallet');
  if (last) setTimeout(() => { const w = wallets().find(x => walletKey(x) === last); if (w) use(w, false).catch(() => {}); }, 400);
}
async function copy(text, b){
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch (e){
    const t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.append(t); t.select();
    try { ok = document.execCommand('copy'); } catch (e2) {}
    t.remove();
  }
  toast(ok ? 'Contract address copied' : 'Copy failed. Select the address and copy it by hand');
  if (ok && b){ const s = b.textContent; b.textContent = 'Copied'; clearTimeout(b._t); b._t = setTimeout(() => { b.textContent = s; }, 1400); }
}
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start); else start();
})();
