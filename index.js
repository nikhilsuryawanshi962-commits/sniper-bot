/*

Node.js Solana Sniper Bot — Detect new Raydium pairs on Dexscreener,

auto BUY/SELL via Jupiter, with Telegram controls and safety filters.

▶ ENV (Render/ Railway → Environment):

TELEGRAM_BOT_TOKEN   = your bot token

TELEGRAM_CHAT_ID     = your chat id (from @userinfobot)

RPC_URL              = https://api.mainnet-beta.solana.com (or your provider)

PRIVATE_KEY          = wallet secret (supports Phantom JSON array OR base58)

------------------------------------ (optional tuning)

BUY_SOL              = 0.02         // SOL to spend per trade

MIN_LIQ_USD          = 20000        // min liquidity filter

MAX_AGE_SEC          = 180          // pair must be newer than this

DEX_FILTER           = raydium      // only this DEX id

SLIPPAGE_BPS         = 200          // 2%

TP_PCT               = 25           // +25% take profit

SL_PCT               = 15           // -15% stop loss

BLACKLIST_WORDS      = test,honeypot,scam,pepe2.0

▶ Start:  node index.js

NOTE: This is a starter reference. DYOR. Trading is risky. */


import 'dotenv/config'; import fetch from 'node-fetch'; import TelegramBot from 'node-telegram-bot-api'; import bs58 from 'bs58'; import { Connection, Keypair, VersionedTransaction, PublicKey, sendAndConfirmRawTransaction, } from '@solana/web3.js';

// ========= Config from ENV ========= const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''; const CHAT_ID = process.env.TELEGRAM_CHAT_ID || ''; const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'; const PRIVATE_KEY_RAW = process.env.PRIVATE_KEY || '';

// Strategy / filters let BUY_SOL = Number(process.env.BUY_SOL || 0.02); const MIN_LIQ_USD = Number(process.env.MIN_LIQ_USD || 20000); const MAX_AGE_SEC = Number(process.env.MAX_AGE_SEC || 180); const DEX_FILTER = (process.env.DEX_FILTER || 'raydium').toLowerCase(); const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 200); const TP_PCT = Number(process.env.TP_PCT || 25); const SL_PCT = Number(process.env.SL_PCT || 15); const BLACKLIST_WORDS = (process.env.BLACKLIST_WORDS || 'test,honeypot,scam').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);

// ========= Globals ========= const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null; const conn = new Connection(RPC_URL, { commitment: 'confirmed' });

const SOL_MINT = 'So11111111111111111111111111111111111111112'; const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

let paperMode = !PRIVATE_KEY_RAW; // if no PK, run in simulation mode let wallet = null; try { if (!paperMode) wallet = parseWallet(PRIVATE_KEY_RAW); } catch (e) { log(⚠️ PRIVATE_KEY parse failed, switching to PAPER mode. Error: ${e.message}); paperMode = true; }

let ARMED = true; const seenPairs = new Set(); const openPositions = new Map(); // pairAddress -> { symbol, entryUsd, buySig, status }

// ========= Helpers ========= function log(msg) { console.log(msg); if (bot && CHAT_ID) bot.sendMessage(CHAT_ID, String(msg)).catch(()=>{}); }

function parseWallet(secret) { // supports Phantom JSON array ("[12,34,...]") OR base58 string try { const arr = JSON.parse(secret); const sk = Uint8Array.from(arr); return Keypair.fromSecretKey(sk); } catch (_) { const decoded = bs58.decode(secret); return Keypair.fromSecretKey(Uint8Array.from(decoded)); } }

function nowMs(){ return Date.now(); } function ageSec(tsMs){ return Math.max(0, Math.floor((nowMs() - (tsMs||0))/1000)); } function fmtUsd(n){ const v = Number(n||0); return isFinite(v)? $${v.toLocaleString(undefined,{maximumFractionDigits:0})} : String(n); } function passBlacklist(name='', symbol=''){ const s = ${name} ${symbol}.toLowerCase(); return BLACKLIST_WORDS.every(w => !s.includes(w)); }

// ========= Dexscreener ========= async function fetchNewPairs(limit=30){ try { const url = 'https://api.dexscreener.com/latest/dex/search?q=solana'; const r = await fetch(url, { timeout: 10000 }); const j = await r.json(); const pairs = Array.isArray(j.pairs)? j.pairs : []; pairs.sort((a,b)=> (b.pairCreatedAt||0) - (a.pairCreatedAt||0)); return pairs.slice(0, limit); } catch (e) { console.error('Dexscreener fetch error', e); return []; } }

function filterPair(p){ if ((p.chainId||'').toLowerCase() !== 'solana') return [false, 'not solana']; if (DEX_FILTER && (p.dexId||'').toLowerCase() !== DEX_FILTER) return [false, dex != ${DEX_FILTER}]; const age = ageSec(p.pairCreatedAt||0); if (age > MAX_AGE_SEC) return [false, too old (${age}s)]; const liq = ((p.liquidity||{}).usd)||0; if (liq < MIN_LIQ_USD) return [false, liq ${liq} < ${MIN_LIQ_USD}]; const base = p.baseToken||{}; if (!passBlacklist(base.name, base.symbol)) return [false, 'blacklist']; return [true, 'ok']; }

// ========= Jupiter ========= async function jupQuote(inputMint, outputMint, amount, slippageBps){ const u = new URL('https://lite-api.jup.ag/swap/v1/quote'); u.searchParams.set('inputMint', inputMint); u.searchParams.set('outputMint', outputMint); u.searchParams.set('amount', String(amount)); u.searchParams.set('slippageBps', String(slippageBps)); const r = await fetch(u.toString(), { timeout: 15000 }); if (!r.ok) throw new Error(quote http ${r.status}); return await r.json(); }

async function jupSwap(quoteResp, userPubkey, asLegacy=false){ const body = { userPublicKey: String(userPubkey), quoteResponse: quoteResp, wrapAndUnwrapSol: true, asLegacyTransaction: !!asLegacy, }; const r = await fetch('https://lite-api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), timeout: 20000, }); if (!r.ok) throw new Error(swap http ${r.status}); const j = await r.json(); return j.swapTransaction; // base64 }

function solToLamports(sol){ return Math.floor(sol * 1_000_000_000); }

async function sendSignedTx(base64Tx){ if (paperMode) return PAPER-TX-${Date.now()}; const buf = Buffer.from(base64Tx, 'base64'); const vtx = VersionedTransaction.deserialize(buf); vtx.sign([wallet]); const raw = Buffer.from(vtx.serialize()); const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' }); await conn.confirmTransaction(sig, 'confirmed'); return sig; }

// ========= Trading ========= async function placeBuy(baseMint, pair){ const base = pair.baseToken || {}; const symbol = base.symbol || 'NEW'; if (paperMode) { const sig = PAPER-BUY-${symbol}-${Date.now()}; const entryUsd = Number(pair.priceUsd || 0); openPositions.set(pair.pairAddress, { symbol, entryUsd, amountSol: BUY_SOL, buySig: sig, status: 'OPEN' }); return [true, sig]; } try { const quote = await jupQuote(SOL_MINT, baseMint, solToLamports(BUY_SOL), SLIPPAGE_BPS); const txb64 = await jupSwap(quote, wallet.publicKey.toBase58()); const sig = await sendSignedTx(txb64); const entryUsd = Number(pair.priceUsd || 0); openPositions.set(pair.pairAddress, { symbol, entryUsd, amountSol: BUY_SOL, buySig: sig, status: 'OPEN' }); return [true, sig]; } catch (e) { return [false, e.message || String(e)]; } }

async function placeSell(baseMint, symbol){ if (paperMode) return [true, PAPER-SELL-${symbol}-${Date.now()}]; try { const quote = await jupQuote(baseMint, SOL_MINT, solToLamports(BUY_SOL), SLIPPAGE_BPS); const txb64 = await jupSwap(quote, wallet.publicKey.toBase58()); const sig = await sendSignedTx(txb64); return [true, sig]; } catch (e) { return [false, e.message||String(e)]; } }

async function maybeManage(pair){ const pos = openPositions.get(pair.pairAddress); if (!pos || pos.status !== 'OPEN') return; const price = Number(pair.priceUsd || 0); const entry = Number(pos.entryUsd || 0); if (!price || !entry) return; const changePct = ((price - entry) / entry) * 100; if (changePct >= TP_PCT) { const baseMint = (pair.baseToken||{}).address; const [ok, sig] = await placeSell(baseMint, pos.symbol); if (ok) { pos.status = 'CLOSED_TP'; pos.sellSig = sig; log(✅ TP hit ${pos.symbol} (+${TP_PCT}%) → ${sig}); } else log(❌ TP sell failed: ${sig}); } else if (changePct <= -SL_PCT) { const baseMint = (pair.baseToken||{}).address; const [ok, sig] = await placeSell(baseMint, pos.symbol); if (ok) { pos.status = 'CLOSED_SL'; pos.sellSig = sig; log(⚠️ SL hit ${pos.symbol} (-${SL_PCT}%) → ${sig}); } else log(❌ SL sell failed: ${sig}); } }

// ========= Scanner ========= async function scanLoop(){ while (true) { try { const pairs = await fetchNewPairs(30); for (const p of pairs) { const id = p.pairAddress; if (!id) continue; const base = p.baseToken || {}; const symbol = base.symbol || 'NEW'; const age = ageSec(p.pairCreatedAt||0); const liq = ((p.liquidity||{}).usd)||0; const url = p.url;

const [ok, why] = filterPair(p);
    if (ok && ARMED && !seenPairs.has(id)) {
      seenPairs.add(id);
      log(`🆕 ${symbol} on ${p.dexId} | age ${age}s | liq ${fmtUsd(liq)}\n${url}\n▶ BUY ${BUY_SOL} SOL | slippage ${(SLIPPAGE_BPS/100).toFixed(2)}% | mode ${paperMode? 'PAPER':'LIVE'}`);
      const [success, sig] = await placeBuy(base.address, p);
      if (success) log(`✅ BUY placed ${symbol} → ${sig}`); else log(`❌ BUY failed: ${sig}`);
    } else {
      // mark seen to avoid reprocessing borderline pairs
      if (why !== 'too old') seenPairs.add(id);
    }
    // manage open pos
    await maybeManage(p);
  }
} catch (e) { console.error('scanLoop error', e); }
await sleep(5000);

} }

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// ========= Telegram Commands ========= async function send(msg){ if (bot && CHAT_ID) return bot.sendMessage(CHAT_ID, msg).catch(()=>{}); }

async function handleCommand(text){ const [cmd, ...args] = text.trim().split(/\s+/); if (cmd === '/start') { await send( 🤖 Solana Sniper Bot\n+ Status: ${ARMED? 'ARMED':'DISARMED'} | Mode: ${paperMode? 'PAPER':'LIVE'}\n+ Filters: liq>=${fmtUsd(MIN_LIQ_USD)}, age<=${MAX_AGE_SEC}s, dex=${DEX_FILTER}\n+ Trade: ${BUY_SOL} SOL | TP=${TP_PCT}% | SL=${SL_PCT}%\n+ RPC: ${RPC_URL} ); } else if (cmd === '/arm') { ARMED = true; await send('🟢 ARMED'); } else if (cmd === '/disarm') { ARMED = false; await send('🔴 DISARMED'); } else if (cmd === '/paper') { paperMode = true; await send('🧪 PAPER MODE'); } else if (cmd === '/live') { if (!wallet) return send('❌ No PRIVATE_KEY loaded'); paperMode = false; await send('💸 LIVE MODE'); } else if (cmd === '/setbuy') { const v = Number(args[0]); if (isFinite(v) && v>0) { BUY_SOL = v; await send(✅ BUY_SOL = ${BUY_SOL} SOL); } else await send('Usage: /setbuy 0.02'); } else if (cmd === '/status') { const rows = []; rows.push(📊 Positions: ${openPositions.size}); for (const [k,v] of openPositions) rows.push(- ${v.symbol}: ${v.status} | entry=$${v.entryUsd ?? '?'}); await send(rows.join('\n')); } else if (cmd === '/watch') { await send('👀 Watching new pairs…'); // (scanner already looping) } else if (cmd === '/buy') { const mint = args[0]; if (!mint) return send('Usage: /buy <mint>'); const fakePair = { baseToken: { address: mint, symbol: mint.slice(0,4)+'..' }, pairAddress: manual-${mint}, priceUsd: 0 }; const [ok, sig] = await placeBuy(mint, fakePair); if (ok) await send(✅ Manual BUY ok → ${sig}); else await send(❌ Manual BUY failed: ${sig}); } else if (cmd === '/sell') { const mint = args[0]; if (!mint) return send('Usage: /sell <mint>'); const [ok, sig] = await placeSell(mint, mint.slice(0,4)+'..'); if (ok) await send(✅ Manual SELL ok → ${sig}); else await send(❌ Manual SELL failed: ${sig}); } }

function initTelegramPolling(){ if (!bot) return; // lightweight long-polling for commands let offset = 0; setInterval(async()=>{ try { const r = await fetch(https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=20&offset=${offset+1}); const j = await r.json(); const updates = j.result || []; for (const u of updates) { offset = u.update_id; const text = u.message?.text || u.edited_message?.text; const chat = u.message?.chat?.id || u.edited_message?.chat?.id; if (!text || !chat || String(chat)!==String(CHAT_ID)) continue; // only accept from configured chat await handleCommand(text); } } catch (e) {} }, 2500); }

// ========= Main ========= (async function main(){ console.log('Starting Solana Sniper Bot (Node)…'); console.log(Mode: ${paperMode? 'PAPER':'LIVE'}); if (wallet) console.log(Wallet: ${wallet.publicKey.toBase58()}); if (bot && CHAT_ID) await send('🚀 Bot online. Use /start, /watch, /arm, /disarm, /paper, /live, /setbuy, /status, /buy <mint>, /sell <mint>'); initTelegramPolling(); // kick off scanner scanLoop().catch(console.error); })();

