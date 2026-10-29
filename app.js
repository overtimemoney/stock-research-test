/* Stock Research PWA — personal stock research with live data.
 * Data sources (public, no key): Finviz (fundamentals), Nasdaq API
 * (quote, summary, EPS forecasts), Yahoo Finance chart (1y history).
 * None of them send CORS headers, so every request goes through a chain
 * of public CORS relays; the first that answers wins. Quotes are cached
 * 15 minutes in localStorage. Missing fields stay missing — never faked. */
'use strict';

/* ============================== utilities ============================== */
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function isNum(n) { return typeof n === 'number' && isFinite(n); }
function fmtMoney(n, dec) {
  if (!isNum(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: dec == null ? 2 : dec, maximumFractionDigits: dec == null ? 2 : dec });
}
function fmtNum(n, dec) {
  if (!isNum(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: dec == null ? 2 : dec, maximumFractionDigits: dec == null ? 2 : dec });
}
function fmtPct(n, dec) {
  if (!isNum(n)) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(dec == null ? 1 : dec) + '%';
}
function fmtCap(n) { // dollars -> $969.1B
  if (!isNum(n)) return '—';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  return fmtMoney(n, 0);
}
function parseNum(s) {
  if (s == null) return null;
  if (typeof s === 'number') return isFinite(s) ? s : null;
  var t = String(s).replace(/[$,%]/g, '').replace(/,/g, '').trim();
  if (!t || t === '-' || t === '—' || /^n\/?a$/i.test(t) || /^none$/i.test(t)) return null;
  var n = parseFloat(t);
  return isNaN(n) ? null : n;
}
function parseCapStr(s) { // "969.05B" / "12.3M" / "1.2T"
  if (s == null) return null;
  var m = String(s).trim().match(/^([\d.,]+)\s*([BMT])?$/i);
  if (!m) return parseNum(s);
  var n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n)) return null;
  var u = (m[2] || '').toUpperCase();
  if (u === 'T') return n * 1e12;
  if (u === 'B') return n * 1e9;
  if (u === 'M') return n * 1e6;
  return n;
}
function lsGet(key, fallback) {
  try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

/* ============================== relay fetch ============================== */
var RELAYS = [
  // The user's own Cloudflare Worker relay (deployed 2026-10-24) — first
  // route: fast and reliable. The free public relays below stay as backup.
  function (u) { return 'https://stock-research-relay.supplessayings-6e6.workers.dev/?url=' + encodeURIComponent(u); },
  function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); },
  function (u) { return 'https://api.cors.lol/?url=' + encodeURIComponent(u); },
  function (u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); },
  function (u) { return 'https://corsproxy.io/?url=' + encodeURIComponent(u); }
];
function fetchWithTimeout(url, ms) {
  if (typeof AbortController === 'undefined') return fetch(url);
  var ctl = new AbortController();
  var to = setTimeout(function () { ctl.abort(); }, ms);
  return fetch(url, { signal: ctl.signal }).finally(function () { clearTimeout(to); });
}
/* Race every route at once (direct + all relays); the first response that
 * validates wins. Sequential relay fallback could stack 4 timeouts per
 * source and look like a perpetual spinner, so everything runs parallel. */
/* Which route served the first successful fetch of a lookup: 'your relay'
 * (the user's Cloudflare Worker), 'public relay' (a backup) or 'direct'.
 * Shown on the scorecard so the user can see what actually carried data. */
var FIRST_ROUTE = null;
function relayFetch(url, opts) {
  opts = opts || {};
  var timeout = opts.timeout || 10000;
  var attempts = [url];
  for (var i = 0; i < RELAYS.length; i++) attempts.push(RELAYS[i](url));
  return new Promise(function (resolve, reject) {
    var done = false, pending = attempts.length, lastErr = null;
    var killer = setTimeout(function () {
      if (!done) { done = true; reject(lastErr || new Error('data sources timed out')); }
    }, timeout);
    attempts.forEach(function (u, ai) {
      fetchWithTimeout(u, timeout).then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.text();
      }).then(function (text) {
        if (!text || text.length < 8) throw new Error('empty response');
        if (/error code: 5\d\d|Rate limit exceeded/i.test(text) && text.length < 200) {
          throw new Error('relay busy');
        }
        if (opts.validate && !opts.validate(text)) throw new Error('unexpected content');
        if (!done) {
          done = true; clearTimeout(killer);
          if (!FIRST_ROUTE) FIRST_ROUTE = ai === 0 ? 'direct' : (ai === 1 ? 'your relay' : 'public relay');
          resolve(text);
        }
      }).catch(function (e) {
        lastErr = e; pending--;
        if (!done && pending === 0) { done = true; clearTimeout(killer); reject(lastErr || new Error('all relays failed')); }
      });
    });
  });
}
async function relayJSON(url) {
  var text = await relayFetch(url, { validate: function (t) { return t.trim().charAt(0) === '{'; } });
  return JSON.parse(text);
}

/* ============================== source parsers ============================== */
/* Finviz stock page: label/content pairs live inside the same <tr>.
 * Regex-based (not DOMParser) so the exact shipped code is testable. */
function stripTags(s) { return String(s).replace(/<[^>]+>/g, '').trim(); }
function parseFinviz(html) {
  var pairs = {};
  var trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi, trM;
  while ((trM = trRe.exec(html)) !== null) {
    var block = trM[1];
    var labs = [], cons = [], m;
    var labRe = /class="snapshot-td-label">(?:<a[^>]*>)?([^<]+)/g;
    while ((m = labRe.exec(block)) !== null) labs.push(m[1].trim());
    var conRe = /class="snapshot-td-content">([\s\S]*?)<\/div>/g;
    while ((m = conRe.exec(block)) !== null) cons.push(stripTags(m[1]));
    labs.forEach(function (key, i) {
      if (key && !(key in pairs)) pairs[key] = cons[i] || '';
    });
  }
  return pairs;
}
function finvizPctBelowHigh(pairs) {
  var raw = pairs['52W High'] || ''; // e.g. "1255.00 -31.75%"
  var m = raw.match(/(-?[\d.]+)%/);
  if (m) return Math.abs(parseFloat(m[1]));
  var hi = parseNum((raw.split(' ')[0] || ''));
  return hi; // caller falls back to price math if this looks like a price
}

/* "$63.34B" / "$890M" style strings to plain numbers. */
function parseRevStr(s) {
  if (!s) return null;
  var m = String(s).replace(/[$,]/g, '').trim().match(/^([\d.]+)\s*([BMK])?$/i);
  if (!m) return null;
  var v = parseFloat(m[1]);
  if (!isNum(v)) return null;
  var u = (m[2] || '').toUpperCase();
  return u === 'B' ? v * 1e9 : u === 'M' ? v * 1e6 : u === 'K' ? v * 1e3 : v;
}

/* MarketBeat earnings page: the history table with Consensus Estimate vs
 * Reported EPS per quarter (newest first). Their free table carries the
 * last ~8-9 quarters — the deepest EPS-surprise history fetchable without
 * a paid API key (Nasdaq/Zacks publish only 4). */
function parseMBEarnings(html) {
  var tables = String(html).match(/<table[\s\S]*?<\/table>/g) || [];
  for (var ti = 0; ti < tables.length; ti++) {
    var t = tables[ti];
    if (t.indexOf('Consensus Estimate') === -1 || t.indexOf('Reported EPS') === -1) continue;
    var rows = [], trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi, trM;
    while ((trM = trRe.exec(t)) !== null) {
      var cells = [], tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi, tdM;
      while ((tdM = tdRe.exec(trM[1])) !== null) cells.push(stripTags(tdM[1]));
      if (cells.length >= 4) {
        var consensus = parseNum(cells[2]);
        var reported = parseNum(cells[3]);
        if (isNum(consensus) && isNum(reported)) {
          rows.push({
            date: cells[0], quarter: cells[1], consensus: consensus, reported: reported,
            rev: cells.length >= 8 ? parseRevStr(cells[7]) : null
          });
        }
      }
    }
    if (rows.length) return rows.slice(0, 20);
  }
  return [];
}
/* Miss = reported EPS below the consensus estimate; within a tenth of a
 * cent counts as in line. Returns counts plus miss/beat percentages. */
function epsRecordStats(rows) {
  var n = rows.length, misses = 0, beats = 0, meets = 0;
  rows.forEach(function (r) {
    var diff = r.reported - r.consensus;
    if (diff < -0.001) misses++; else if (diff > 0.001) beats++; else meets++;
  });
  return {
    n: n, misses: misses, beats: beats, meets: meets,
    missPct: n ? Math.round(misses / n * 100) : null,
    beatPct: n ? Math.round(beats / n * 100) : null
  };
}

/* ============================== data assembly ============================== */
var CACHE_KEY = 'sr_qcache_v1';
var CACHE_TTL = 15 * 60 * 1000;

/* Fill a stock object from a parsed Finviz snapshot. Shared by the
 * full scorecard fetch and the watchlist's light valuation pass. */
function fillFromFinviz(d, fvHtml) {
  var p = parseFinviz(fvHtml);
  if (!p['Price'] && !p['Market Cap']) throw new Error('no snapshot');
  d.sourceFinviz = p;
  d.name = d.name || null;
  d.price = parseNum(p['Price']);
  d.marketCap = parseCapStr(p['Market Cap']);
  d.pe = parseNum(p['P/E']);
  d.forwardPE = parseNum(p['Forward P/E']);
  d.peg = parseNum(p['PEG']);
  d.epsTTM = parseNum(p['EPS (ttm)']);
  d.epsNextY = parseNum(p['EPS next Y']);
  d.epsThisY = parseNum(p['EPS this Y']);
  var g5 = p['EPS next 5Y'] || '';
  d.epsGrowth5Y = parseNum(g5);
  d.epsGrowthTTM = parseNum(p['EPS Y/Y TTM']);
  d.salesGrowthTTM = parseNum(p['Sales Y/Y TTM']);
  d.grossMargin = parseNum(p['Gross Margin']);
  d.operMargin = parseNum(p['Oper. Margin']);
  d.profitMargin = parseNum(p['Profit Margin']);
  d.debtEq = parseNum(p['Debt/Eq']);
  d.beta = parseNum(p['Beta']);
  d.currentRatio = parseNum(p['Current Ratio']);
  d.roe = parseNum(p['ROE']);
  // Finviz renamed "Dividend %" away: the yield now rides in parens in
  // "Dividend TTM" / "Dividend Est." — e.g. "2.10 (2.27%)". "-" when the
  // stock pays no dividend.
  var divRaw = p['Dividend TTM'] || p['Dividend Est.'] || '';
  var divM = divRaw.match(/\(([\d.]+)%\)/);
  if (divM) d.divYield = parseFloat(divM[1]);
  else if (isNum(parseNum(p['Dividend %']))) d.divYield = parseNum(p['Dividend %']);
  var hiParts = (p['52W High'] || '').split(/\s+/);
  var loParts = (p['52W Low'] || '').split(/\s+/);
  d.high52 = parseNum(hiParts[0]);
  d.low52 = parseNum(loParts[0]);
  var pctM = (p['52W High'] || '').match(/(-?[\d.]+)%/);
  if (pctM) d.pctBelowHigh = Math.abs(parseFloat(pctM[1]));
  d.companyName = null; // finviz quote page title handled by Nasdaq below
  var titleM = fvHtml.match(/<title>([^<]+)<\/title>/i);
  if (titleM) {
    var nm = titleM[1].replace(/\s+Stock Price.*$/i, '').replace(/\s+Quote.*$/i, '').trim();
    // Finviz titles look like "MU - Micron Technology Inc Stock Price and Quote"
    var dashParts = nm.split(' - ');
    if (dashParts.length > 1) d.companyName = dashParts.slice(1).join(' - ').trim();
  }
  d.sources.push('Finviz');
}

async function fetchStock(ticker, opts) {
  opts = opts || {};
  var T = String(ticker || '').trim().toUpperCase();
  if (!T) throw new Error('Enter a ticker symbol.');
  var cache = lsGet(CACHE_KEY, {});
  var hit = cache[T];
  if (!opts.fresh && hit && (Date.now() - hit.ts) < CACHE_TTL && hit.data) {
    hit.data.fromCache = true;
    return hit.data;
  }
  var d = { ticker: T, sources: [], errors: [] };
  FIRST_ROUTE = null;

  // --- Finviz: fundamentals workhorse ---
  var srcFinviz = async function () { try {
    var fvHtml = await relayFetch('https://finviz.com/stock?t=' + encodeURIComponent(T), {
      validate: function (t) { return t.indexOf('snapshot-td-label') !== -1; }
    });
    fillFromFinviz(d, fvHtml);
  } catch (e) { d.errors.push('Finviz: ' + e.message); } };

  // --- Nasdaq: quote + summary + EPS forecasts ---
  var srcNasdaqInfo = async function () { try {
    var info = await relayJSON('https://api.nasdaq.com/api/quote/' + encodeURIComponent(T) + '/info?assetclass=stocks');
    var id = (info && info.data) || {};
    if (id.companyName) d.companyName = String(id.companyName).replace(/\s+(Common Stock|Class A.*|Common Shares)$/i, '').trim();
    if (id.exchange) d.exchange = id.exchange;
    var pd = id.primaryData || {};
    var nqPrice = parseNum(pd.lastSalePrice);
    if (isNum(nqPrice)) { if (!isNum(d.price)) d.price = nqPrice; d.nasdaqPrice = nqPrice; }
    d.dayChangePct = parseNum(pd.percentageChange);
    var ks = (id.keyStats || {}).fiftyTwoWeekHighLow || {};
    var rangeM = String(ks.value || '').match(/([\d.,]+)\s*-\s*([\d.,]+)/);
    if (rangeM) {
      if (!isNum(d.low52)) d.low52 = parseNum(rangeM[1]);
      if (!isNum(d.high52)) d.high52 = parseNum(rangeM[2]);
    }
    d.sources.push('Nasdaq');
  } catch (e) { d.errors.push('Nasdaq quote: ' + e.message); } };

  var srcNasdaqSummary = async function () { try {
    var sum = await relayJSON('https://api.nasdaq.com/api/quote/' + encodeURIComponent(T) + '/summary?assetclass=stocks');
    var sd = (sum && sum.data && sum.data.summaryData) || {};
    var mc = sd.MarketCap ? parseNum(sd.MarketCap.value) : null;
    if (isNum(mc) && !isNum(d.marketCap)) d.marketCap = mc;
    if (sd.Sector) d.sector = sd.Sector.value;
    if (sd.Industry) d.industry = sd.Industry.value;
    if (sd.OneYrTarget) d.target1Y = parseNum(sd.OneYrTarget.value);
    if (sd.Yield && !isNum(d.divYield)) d.divYield = parseNum(sd.Yield.value);
    if (sd.PreviousClose) d.prevClose = parseNum(sd.PreviousClose.value);
  } catch (e) { d.errors.push('Nasdaq summary: ' + e.message); } };

  var srcNasdaqForecast = async function () { try {
    var fc = await relayJSON('https://api.nasdaq.com/api/analyst/' + encodeURIComponent(T) + '/earnings-forecast?assetclass=stocks');
    var rows = (fc && fc.data && fc.data.yearlyForecast && fc.data.yearlyForecast.rows) || [];
    d.epsForecasts = rows.map(function (r) {
      return {
        fiscalEnd: r.fiscalEnd,
        eps: typeof r.consensusEPSForecast === 'number' ? r.consensusEPSForecast : parseNum(r.consensusEPSForecast),
        high: parseNum(r.highEPSForecast),
        low: parseNum(r.lowEPSForecast),
        n: parseNum(r.noOfEstimates)
      };
    }).filter(function (r) { return isNum(r.eps); });
    if (d.epsForecasts.length) d.sources.push('Nasdaq estimates');
  } catch (e) { d.errors.push('Nasdaq forecasts: ' + e.message); d.epsForecasts = []; } };

  // --- MarketBeat: EPS surprise history (consensus vs reported) ---
  // --- StockAnalysis forecast page: annual revenue, actual + estimated,
  // --- by fiscal year. Feeds the boom-bust risk factor. ---
  var srcRevPath = async function () { try {
    var html = await relayFetch('https://stockanalysis.com/stocks/' + encodeURIComponent(T) + '/forecast/', {
      timeout: 20000,
      validate: function (t) { return t.indexOf('Fiscal Year') !== -1 && t.indexOf('Revenue') !== -1; }
    });
    var rp = parseSAForecast(html);
    if (rp.length >= 3) { d.revPath = rp; d.sources.push('StockAnalysis'); }
  } catch (e) { d.errors.push('Revenue path: ' + e.message); } };

  var srcSurprise = async function () { try {
    var ex = String(d.exchange || '').toUpperCase();
    var segs = [];
    if (['NASDAQ', 'NYSE', 'AMEX'].indexOf(ex) !== -1) segs.push(ex);
    ['NASDAQ', 'NYSE'].forEach(function (s) { if (segs.indexOf(s) === -1) segs.push(s); });
    var urls = segs.slice(0, 2).map(function (s) {
      return 'https://www.marketbeat.com/stocks/' + s + '/' + encodeURIComponent(T) + '/earnings/';
    });
    var html = await new Promise(function (resolve, reject) {
      var pending = urls.length, done = false;
      urls.forEach(function (u) {
        relayFetch(u, { timeout: 15000, validate: function (t) { return t.indexOf('Reported EPS') !== -1 && t.indexOf('Consensus Estimate') !== -1; } })
          .then(function (text) { if (!done) { done = true; resolve(text); } })
          .catch(function (e) { pending--; if (pending === 0 && !done) reject(e || new Error('no earnings history')); });
      });
    });
    var rows = parseMBEarnings(html);
    if (rows.length >= 4) {
      d.epsRecord = epsRecordStats(rows);
      d.sources.push('MarketBeat');
    }
    // Latest quarter's revenue growth: newest quarter vs the same
    // quarter a year earlier (4 rows back in the newest-first table).
    if (rows.length >= 5 && isNum(rows[0].rev) && isNum(rows[4].rev) && rows[4].rev > 0) {
      d.revGrowthQtr = (rows[0].rev / rows[4].rev - 1) * 100;
    }
  } catch (e) { d.errors.push('EPS history: ' + e.message); } };

  // --- Yahoo chart: 1y weekly price history ---
  var srcYahoo = async function () { try {
    var ch = await relayJSON('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(T) + '?range=1y&interval=1wk');
    var res = ch && ch.chart && ch.chart.result && ch.chart.result[0];
    if (res) {
      var rawCloses = (res.indicators && res.indicators.quote && res.indicators.quote[0].close) || [];
      var rawTs = res.timestamp || [];
      var closes = [], tsArr = [];
      rawCloses.forEach(function (c, i) { if (isNum(c)) { closes.push(c); tsArr.push(rawTs[i] || null); } });
      d.history = closes;
      d.historyTs = tsArr;
      var meta = res.meta || {};
      if (!isNum(d.price) && isNum(meta.regularMarketPrice)) d.price = meta.regularMarketPrice;
      if (!isNum(d.high52) && isNum(meta.fiftyTwoWeekHigh)) d.high52 = meta.fiftyTwoWeekHigh;
      if (!isNum(d.low52) && isNum(meta.fiftyTwoWeekLow)) d.low52 = meta.fiftyTwoWeekLow;
      if (!d.companyName && meta.longName) d.companyName = meta.longName;
      d.sources.push('Yahoo');
    }
  } catch (e) { d.errors.push('Yahoo chart: ' + e.message); } };

  // Fast stage: the four small JSON sources in parallel. Finviz (a huge
  // HTML page through a relay) runs after, so price/chart/EPS render
  // immediately and valuation details fill in when they land.
  await Promise.all([srcNasdaqInfo(), srcNasdaqSummary(), srcNasdaqForecast(), srcYahoo()]);
  deriveValues(d);
  if (opts.onStage && (isNum(d.price) || isNum(d.marketCap))) {
    d.partial = true;
    d.route = FIRST_ROUTE;
    d.fetchedAt = Date.now();
    try { opts.onStage(d); } catch (e) {}
  }
  // Slow stage: Finviz fundamentals + MarketBeat EPS-surprise history in
  // parallel — both are big HTML pages through the relays.
  await Promise.all([srcFinviz(), srcSurprise(), srcRevPath()]);
  deriveValues(d);
  d.partial = false;

  // --- derived values (transparent arithmetic on sourced numbers) ---
  function deriveValues(d) {
  if (!isNum(d.pctBelowHigh) && isNum(d.price) && isNum(d.high52) && d.high52 > 0) {
    d.pctBelowHigh = Math.max(0, (1 - d.price / d.high52) * 100);
  }
  if (!isNum(d.dayChangePct) && isNum(d.price) && isNum(d.prevClose) && d.prevClose > 0) {
    d.dayChangePct = (d.price / d.prevClose - 1) * 100;
  }
  // EPS growth: next fiscal year vs this fiscal year (consensus,
  // fiscal-year over fiscal-year). Deliberately NOT vs trailing TTM:
  // a trailing window straddling weak reported quarters distorts the
  // base and inflates the figure (Justin's call, 2026-10-25).
  var nextFY = (d.epsForecasts && d.epsForecasts[0]) || null;
  var f1 = (d.epsForecasts && d.epsForecasts[1]) || null;
  if (nextFY && f1 && isNum(nextFY.eps) && isNum(f1.eps) && nextFY.eps > 0) {
    d.epsGrowthNextY = (f1.eps / nextFY.eps - 1) * 100;
  } else if (isNum(d.epsNextY) && isNum(d.epsThisY) && d.epsThisY > 0) {
    d.epsGrowthNextY = (d.epsNextY / d.epsThisY - 1) * 100;
  } else {
    d.epsGrowthNextY = null;
  }
  // Forward P/E fallback: price / next-FY consensus EPS (labelled calc.)
  if (!isNum(d.forwardPE) && isNum(d.price)) {
    var fyEps = isNum(d.epsNextY) ? d.epsNextY : (nextFY ? nextFY.eps : null);
    if (isNum(fyEps) && fyEps > 0) { d.forwardPE = d.price / fyEps; d.forwardPECalc = true; }
  }
  // PEG fallback: forward P/E / next-year EPS growth % (labelled calc.)
  if (!isNum(d.peg) && isNum(d.forwardPE) && isNum(d.epsGrowthNextY) && d.epsGrowthNextY > 0) {
    d.peg = d.forwardPE / d.epsGrowthNextY; d.pegCalc = true;
  }
  }
  d.fetchedAt = Date.now();
  d.route = FIRST_ROUTE;
  d.fromCache = false;
  if (!isNum(d.price) && !isNum(d.marketCap)) {
    throw new Error('Could not load data for "' + T + '" — the data routes may be busy. Check the ticker and try again in a moment.');
  }
  cache[T] = { ts: Date.now(), data: d };
  lsSet(CACHE_KEY, cache);
  return d;
}

/* ============================== scoring ============================== */
/* Transparent rubric — every factor's points are shown to the user. */
function scoreStock(d) {
  var factors = [];
  function band(v, bands) { // bands: [[limitInclusive, points], ...] ascending
    for (var i = 0; i < bands.length; i++) { if (v <= bands[i][0]) return bands[i][1]; }
    return 0;
  }
  function add(name, value, display, max, pts, note) {
    factors.push({ name: name, value: value, display: display, max: max, pts: pts, note: note || '' });
  }
  if (isNum(d.forwardPE) && d.forwardPE > 0) {
    add('Forward P/E', d.forwardPE, fmtNum(d.forwardPE, 2) + (d.forwardPECalc ? ' (calc.)' : ''), 25,
      band(d.forwardPE, [[6, 25], [8, 22], [10, 19], [13, 15], [18, 11], [25, 7], [35, 3], [Infinity, 0]]),
      'Cheaper earnings = more points');
  }
  if (isNum(d.peg) && d.peg > 0) {
    add('PEG ratio', d.peg, fmtNum(d.peg, 2) + (d.pegCalc ? ' (calc.)' : ''), 20,
      band(d.peg, [[0.3, 20], [0.5, 18], [0.75, 15], [1, 12], [1.5, 8], [2, 4], [Infinity, 0]]),
      'Price vs growth — under 0.5 is rare air');
  }
  if (isNum(d.pctBelowHigh)) {
    add('Below 52-wk high', d.pctBelowHigh, fmtNum(d.pctBelowHigh, 1) + '%', 15,
      d.pctBelowHigh >= 40 ? 15 : d.pctBelowHigh >= 30 ? 13 : d.pctBelowHigh >= 25 ? 11 :
      d.pctBelowHigh >= 15 ? 8 : d.pctBelowHigh >= 5 ? 4 : 1,
      'Bigger discount to the high = more points');
  }
  if (isNum(d.epsGrowthNextY)) {
    add('EPS growth, next yr', d.epsGrowthNextY, fmtPct(d.epsGrowthNextY), 15,
      d.epsGrowthNextY >= 50 ? 15 : d.epsGrowthNextY >= 25 ? 13 : d.epsGrowthNextY >= 15 ? 10 :
      d.epsGrowthNextY >= 8 ? 7 : d.epsGrowthNextY >= 0 ? 3 : 0,
      'Consensus EPS, next fiscal year vs this fiscal year');
  }
  if (isNum(d.profitMargin)) {
    add('Profit margin', d.profitMargin, fmtNum(d.profitMargin, 1) + '%', 10,
      d.profitMargin >= 25 ? 10 : d.profitMargin >= 15 ? 8 : d.profitMargin >= 10 ? 6 :
      d.profitMargin >= 5 ? 4 : d.profitMargin > 0 ? 2 : 0, 'Net margin, trailing');
  }
  if (isNum(d.grossMargin)) {
    add('Gross margin', d.grossMargin, fmtNum(d.grossMargin, 1) + '%', 5,
      d.grossMargin >= 60 ? 5 : d.grossMargin >= 45 ? 4 : d.grossMargin >= 30 ? 3 :
      d.grossMargin >= 15 ? 1 : 0, 'Pricing power proxy');
  }
  if (isNum(d.debtEq)) {
    add('Debt / Equity', d.debtEq, fmtNum(d.debtEq, 2), 10,
      d.debtEq <= 0.1 ? 10 : d.debtEq <= 0.4 ? 8 : d.debtEq <= 0.8 ? 6 :
      d.debtEq <= 1.5 ? 3 : d.debtEq <= 3 ? 1 : 0, 'Lower leverage = more points');
  }
  var got = factors.reduce(function (s, f) { return s + f.pts; }, 0);
  var maxAvailable = factors.reduce(function (s, f) { return s + f.max; }, 0);
  var score = maxAvailable > 0 ? Math.round(got / maxAvailable * 100) : null;
  var verdict = null;
  if (score != null) verdict = score >= 70 ? 'Undervalued' : score >= 45 ? 'Fairly valued' : 'Overpriced';
  return { factors: factors, got: got, maxAvailable: maxAvailable, score: score, verdict: verdict };
}

/* Risk score: the mirror image of the valuation score. Same 0-100
 * scale and same normalize-over-available-factors rule, but the points
 * measure danger, not cheapness — higher = riskier. Factors: how hard
 * the stock swings (beta), how much debt it carries (debt/equity),
 * whether it earns money (profit margin), how big it is (market cap),
 * whether earnings are heading down (next-year EPS trend), and whether
 * it can pay its near-term bills (current ratio). */
/* Parse the StockAnalysis forecast page's annual table into a revenue
 * path: [{label:'FY2027', rev:<dollars>, est:<bool>}] ascending by year.
 * Values there use B/M suffixes ('20.25B'); 'Upgrade' cells are the
 * site's paywall and are skipped. A year counts as estimated when its
 * period-end date is still in the future. */
function parseBMV(s) {
  if (s == null) return null;
  var t = String(s).replace(/[$,]/g, '').trim();
  var m = t.match(/^(-?[\d.]+)\s*([BMTK])?$/i);
  if (!m) return null;
  var v = parseFloat(m[1]);
  if (!isFinite(v)) return null;
  var suf = (m[2] || '').toUpperCase();
  if (suf === 'B') v *= 1e9; else if (suf === 'M') v *= 1e6;
  else if (suf === 'T') v *= 1e12; else if (suf === 'K') v *= 1e3;
  return v;
}

function saTables(html) {
  var tables = [];
  var tRe = /<table[\s\S]*?<\/table>/gi, tm;
  while ((tm = tRe.exec(html))) {
    var rows = [];
    var rRe = /<tr[\s\S]*?<\/tr>/gi, rm;
    while ((rm = rRe.exec(tm[0]))) {
      var cells = [];
      var cRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, cm;
      while ((cm = cRe.exec(rm[0]))) cells.push(cm[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function parseSAForecast(html) {
  var out = [];
  saTables(html).forEach(function (rows) {
    var fyRow = null, revRow = null, endRow = null;
    rows.forEach(function (r) {
      if (r[0] === 'Fiscal Year') fyRow = r;
      else if (r[0] === 'Revenue' && !revRow) revRow = r;
      else if (r[0] === 'Period Ending') endRow = r;
    });
    if (!fyRow || !revRow) return;
    var now = Date.now();
    for (var i = 1; i < fyRow.length; i++) {
      var rev = parseBMV(revRow[i]);
      if (!isNum(rev) || rev <= 0) continue;
      var end = endRow ? Date.parse(endRow[i]) : NaN;
      out.push({ label: fyRow[i].replace(/\s+/g, ' '), rev: rev, est: isNum(end) ? end > now : false });
    }
  });
  out.sort(function (a, b) { return a.label.localeCompare(b.label); });
  return out;
}

/* Estimate columns of the StockAnalysis forecast table (annual):
 * every metric the Quarterly Metrics tool charts gets the current
 * fiscal year's consensus where the free page exposes it (later
 * years are paywalled). Margins come straight off the page or are
 * derived from the same columns' $ rows. */
function parseSAForecastMetrics(html) {
  var est = {};
  if (!html) return est;
  saTables(html).forEach(function (rows) {
    if (!rows.length || rows[0][0] !== 'Fiscal Year') return;
    var byLabel = {};
    rows.forEach(function (r) { if (r[0] && byLabel[r[0]] === undefined) byLabel[r[0]] = r; });
    var endRow = byLabel['Period Ending'], hdr = rows[0];
    if (!endRow) return;
    var now = Date.now(), cols = [];
    for (var i = 1; i < hdr.length; i++) {
      var end = Date.parse(endRow[i]);
      if (isNum(end) && end > now) cols.push(i);
    }
    if (!cols.length) return;
    function valAt(rowLabel, i) {
      var r = byLabel[rowLabel];
      return r ? parseBMV(r[i]) : null;
    }
    cols.forEach(function (i) {
      var rev = valAt('Revenue', i);
      function push(key, v) { if (isNum(v)) (est[key] = est[key] || []).push({ plabel: hdr[i], value: v }); }
      push('revenue', rev);
      push('netIncome', valAt('Net Income', i));
      push('fcf', valAt('Free Cash Flow', i));
      var gmRow = byLabel['Gross Margin'];
      var gm = gmRow ? parseNum(gmRow[i]) : null;
      if (!isNum(gm)) { var gp = valAt('Gross Profit', i); gm = (isNum(gp) && isNum(rev) && rev !== 0) ? gp / rev * 100 : null; }
      push('grossMargin', gm);
      var oi = valAt('Operating Income', i);
      push('operMargin', (isNum(oi) && isNum(rev) && rev !== 0) ? oi / rev * 100 : null);
      var ni = valAt('Net Income', i);
      push('netMargin', (isNum(ni) && isNum(rev) && rev !== 0) ? ni / rev * 100 : null);
    });
  });
  return est;
}

/* The StockAnalysis ratios page carries a 'PE Ratio' row across the
 * last five fiscal years (plus a Current column). Its average is the
 * Projection Builder's exit-P/E anchor (Justin's ask, 2026-10-26):
 * what the market has actually paid for this stock's earnings over a
 * full cycle, instead of today's possibly-stretched multiple. */
function parseSAPeHistory(html) {
  var vals = [];
  if (!html) return null;
  saTables(html).forEach(function (rows) {
    if (!rows.length || rows[0][0] !== 'Fiscal Year' || vals.length) return;
    var peRow = null;
    rows.forEach(function (r) { if (r[0] === 'PE Ratio') peRow = r; });
    if (!peRow) return;
    for (var i = 1; i < rows[0].length && vals.length < 5; i++) {
      if (rows[0][i] === 'Current') continue;
      var v = parseNum(peRow[i]);
      if (isNum(v) && v > 0 && v < 1000) vals.push(v);
    }
  });
  if (vals.length < 3) return null;
  var avg = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  return { avg: avg, years: vals.length };
}

var PE5Y_KEY = 'sr_pe5y_v1';
async function fetchPe5yAvg(T) {
  var cache = lsGet(PE5Y_KEY, {});
  var day = new Date().toDateString();
  if (cache[T] && cache[T].day === day) return cache[T].data;
  var html = await relayFetch('https://stockanalysis.com/stocks/' + encodeURIComponent(T) + '/financials/ratios/', {
    timeout: 25000,
    validate: function (t) { return t.indexOf('PE Ratio') !== -1; }
  });
  var data = parseSAPeHistory(html);
  cache[T] = { day: day, data: data };
  lsSet(PE5Y_KEY, cache);
  return data;
}

/* Attach the 5Y average to a stock record (best-effort: any failure
 * leaves the record untouched and the builder falls back to the
 * current P/E). */
async function pjEnsurePe5y(d) {
  if (!d || !d.ticker || isNum(d.pe5yAvg)) return d;
  try {
    var pe = await fetchPe5yAvg(d.ticker);
    if (pe) { d.pe5yAvg = pe.avg; d.pe5yYears = pe.years; }
  } catch (e) {}
  return d;
}

/* The EPS peak-cliff, same detection as the trajectory chart: a later
 * consensus year falls 10%+ below the running peak. */
function epsCliffInfo(d) {
  var pts = epsTrajectory(d).points;
  var peak = -Infinity, peakLabel = '';
  for (var i = 0; i < pts.length; i++) {
    if (pts[i].eps > peak) { peak = pts[i].eps; peakLabel = pts[i].label; }
    else if (peak > 0 && pts[i].eps < peak * 0.90) {
      return { peakLabel: peakLabel, dropLabel: pts[i].label, dropPct: (pts[i].eps / peak - 1) * 100 };
    }
  }
  return null;
}

/* The EPS points alone (TTM actual + up to 4 consensus years, with a
 * next-year fallback), split out of epsTrajectory so other checks can
 * use the points without re-running the warning logic. */
function epsPoints(d) {
  var pts = [];
  if (isNum(d.epsTTM)) pts.push({ label: 'TTM', eps: d.epsTTM, kind: 'actual' });
  (d.epsForecasts || []).slice(0, 4).forEach(function (f) {
    var yr = String(f.fiscalEnd || '').replace(/^[A-Za-z]+\s+/, '');
    pts.push({ label: 'FY' + yr, eps: f.eps, kind: 'est', n: f.n });
  });
  if (pts.length < 2 && isNum(d.epsNextY)) {
    pts.push({ label: 'Next yr est', eps: d.epsNextY, kind: 'est' });
  }
  return pts;
}

/* Possible cliff (Justin's rule, 2026-10-27): with ONLY 2 projected
 * years, an explosive first year followed by a hard growth deceleration
 * is the classic pre-cliff shape — the peak likely sits just past the
 * forecast window, so it counts as a cliff even though no fall is
 * visible inside the window. Fires only when ALL hold: exactly 2
 * projected years beyond TTM; TTM EPS > 0; FY1 growth vs TTM >= +75%;
 * FY2 growth rate <= half the FY1 growth rate. */
function epsPossibleCliff(d) {
  var pts = epsPoints(d);
  if (pts.length !== 3) return null;
  if (pts[0].kind !== 'actual' || pts[1].kind !== 'est' || pts[2].kind !== 'est') return null;
  var ttm = pts[0].eps, f1 = pts[1].eps, f2 = pts[2].eps;
  if (!isNum(ttm) || !isNum(f1) || !isNum(f2) || ttm <= 0 || f1 <= 0) return null;
  var g1 = (f1 / ttm - 1) * 100;
  var g2 = (f2 / f1 - 1) * 100;
  if (g1 < 75) return null;
  if (g2 > g1 * 0.5) return null;
  return { fy1Label: pts[1].label, fy2Label: pts[2].label, g1: g1, g2: g2 };
}

/* No-profit warning (Justin's rule, 2026-10-27): a company losing money
 * today (TTM EPS <= 0) that analysts don't project to turn profitable
 * for at least 4 more years gets a warning on the scorecard. Reads the
 * FULL consensus path (d.epsForecasts, up to 5 years), not the 4-year
 * slice the trajectory chart draws; fiscal labels come from the data.
 * EPS of exactly 0 counts as not profitable. Fires when the first
 * profitable projected year is the 5th or later, or when no projected
 * year is profitable in any available forecast path containing at
 * least one projected year — including paths covering under 4 years.
 * No forecast data stays silent, and an already-profitable company
 * never fires (a later dip is the cliff check's job). Display only —
 * no score reads this. */
function epsProfitWarning(d) {
  if (!isNum(d.epsTTM) || d.epsTTM > 0) return null;
  var fc = (d.epsForecasts || []).filter(function (f) { return f && isNum(f.eps); });
  var label = function (f) { return 'FY' + String(f.fiscalEnd || '').replace(/^[A-Za-z]+\s+/, ''); };
  var firstProfit = -1;
  for (var i = 0; i < fc.length; i++) { if (fc[i].eps > 0) { firstProfit = i; break; } }
  if (firstProfit >= 4) {
    return 'Not projected to be profitable for at least 4 more years — consensus EPS stays negative through ' +
      label(fc[firstProfit - 1]) + '; first profit projected ' + label(fc[firstProfit]) + '.';
  }
  if (firstProfit === -1 && fc.length >= 1) {
    return 'Not projected to be profitable in any year analysts cover — consensus EPS stays negative through ' +
      label(fc[fc.length - 1]) + ', the last year forecast.';
  }
  return null;
}

/* Justin's boom-bust rule (2026-10-26): when the EPS cliff check fires
 * AND revenue doubled (actual or projected) within the 2 years leading
 * up to the revenue top, the name carries peak-cycle risk — the classic
 * value trap. Returns null when the pattern can't be tested. */
function boomBust(d) {
  var rp = d.revPath || [];
  if (rp.length < 3) return null;
  var top = 0;
  for (var i = 1; i < rp.length; i++) { if (rp[i].rev > rp[top].rev) top = i; }
  if (top < 2) return { testable: true, fires: false, ratio: null, topLabel: rp[top].label };
  var ratio = rp[top].rev / rp[top - 2].rev;
  var cliff = epsCliffInfo(d);
  var possibleCliff = cliff ? null : epsPossibleCliff(d);
  return {
    testable: true,
    fires: !!((cliff || possibleCliff) && ratio >= 2),
    ratio: ratio,
    topLabel: rp[top].label,
    projected: rp[top].est,
    cliff: cliff,
    possibleCliff: possibleCliff
  };
}

function riskScore(d) {
  var factors = [];
  function band(v, bands) { // [[limitInclusive, riskPts], ...] ascending limits
    for (var i = 0; i < bands.length; i++) { if (v <= bands[i][0]) return bands[i][1]; }
    return 0;
  }
  function add(name, value, display, max, pts, note) {
    factors.push({ name: name, value: value, display: display, max: max, pts: pts, note: note || '' });
  }
  if (isNum(d.beta) && d.beta > 0) {
    add('Beta (volatility)', d.beta, fmtNum(d.beta, 2), 10,
      band(d.beta, [[0.5, 1], [0.8, 3], [1, 4], [1.3, 6], [1.6, 8], [2, 9], [Infinity, 10]]),
      'How hard the stock swings vs the market');
  }
  if (isNum(d.debtEq) && d.debtEq >= 0) {
    add('Debt / Equity', d.debtEq, fmtNum(d.debtEq, 2), 25,
      band(d.debtEq, [[0.1, 0], [0.4, 5], [0.8, 10], [1.5, 15], [3, 20], [Infinity, 25]]),
      'More debt = less room when things go wrong');
  }
  if (isNum(d.profitMargin)) {
    add('Profit margin', d.profitMargin, fmtNum(d.profitMargin, 1) + '%', 15,
      band(d.profitMargin, [[-10, 15], [0, 13], [5, 10], [10, 7], [15, 4], [25, 2], [Infinity, 0]]),
      'Loss-making means no cushion');
  }
  if (isNum(d.marketCap) && d.marketCap > 0) {
    add('Company size', d.marketCap, fmtCap(d.marketCap), 15,
      band(d.marketCap, [[2e9, 15], [1e10, 11], [5e10, 7], [2e11, 3], [Infinity, 0]]),
      'Small companies fail more often than giants');
  }
  if (isNum(d.epsGrowthNextY)) {
    add('EPS trend, next yr', d.epsGrowthNextY, fmtPct(d.epsGrowthNextY), 15,
      band(d.epsGrowthNextY, [[-25, 15], [-10, 12], [0, 8], [10, 4], [25, 1], [Infinity, 0]]),
      'Falling earnings are where the danger starts');
  }
  if (isNum(d.currentRatio) && d.currentRatio > 0) {
    add('Current ratio', d.currentRatio, fmtNum(d.currentRatio, 2), 10,
      band(d.currentRatio, [[0.8, 10], [1, 8], [1.5, 5], [2, 2], [Infinity, 0]]),
      'Can it pay its near-term bills?');
  }
  var bb = boomBust(d);
  if (bb && bb.testable) {
    add('Boom-bust pattern', bb.ratio, isNum(bb.ratio) ? fmtNum(bb.ratio, 1) + '\u00d7 in 2 yrs' : '\u2014', 25,
      bb.fires ? 25 : 0,
      bb.fires
        ? 'Revenue ' + (bb.projected ? 'is projected to top' : 'topped') + ' at ' + bb.topLabel + ' after doubling in 2 yrs, and EPS ' + (bb.cliff
            ? 'falls off a cliff after ' + bb.cliff.peakLabel
            : 'has a possible cliff after ' + bb.possibleCliff.fy2Label + ' (growth explodes, then decelerates hard, so the peak may sit just past the estimates)') + ' \u2014 the classic peak-cycle trap'
        : 'No doubling-into-a-cliff pattern in the revenue path');
  }
  var got = factors.reduce(function (s, f) { return s + f.pts; }, 0);
  var maxAvailable = factors.reduce(function (s, f) { return s + f.max; }, 0);
  var score = maxAvailable > 0 ? Math.round(got / maxAvailable * 100) : null;
  var verdict = null;
  if (score != null) verdict = score <= 25 ? 'Low risk' : score <= 45 ? 'Moderate risk' : score <= 65 ? 'Elevated risk' : 'High risk';
  return { factors: factors, got: got, maxAvailable: maxAvailable, score: score, verdict: verdict };
}

function valueScreen(d) {
  return [
    { label: 'Market cap over $5B', test: isNum(d.marketCap) ? (d.marketCap > 5e9) : null, value: fmtCap(d.marketCap) },
    { label: 'Forward P/E under 10', test: isNum(d.forwardPE) ? (d.forwardPE < 10) : null, value: isNum(d.forwardPE) ? fmtNum(d.forwardPE, 2) : '—' },
    { label: 'PEG under 0.5', test: isNum(d.peg) ? (d.peg < 0.5) : null, value: isNum(d.peg) ? fmtNum(d.peg, 2) : '—' },
    { label: '25%+ below 52-wk high', test: isNum(d.pctBelowHigh) ? (d.pctBelowHigh >= 25) : null, value: isNum(d.pctBelowHigh) ? fmtNum(d.pctBelowHigh, 1) + '% below' : '—' }
  ];
}

/* Risk screen: the mirror of the value screen — binary safety checks
 * where a pass means the check is CLEAR. Same chip treatment; unknown
 * data shows '?' and never guesses. (Justin's ask, 2026-10-26.) */
function riskScreen(d) {
  var bb = boomBust(d);
  return [
    { label: 'Debt / Equity at or under 1', test: isNum(d.debtEq) ? (d.debtEq <= 1) : null, value: isNum(d.debtEq) ? fmtNum(d.debtEq, 2) : '\u2014' },
    { label: 'Profitable (margin above 0)', test: isNum(d.profitMargin) ? (d.profitMargin > 0) : null, value: isNum(d.profitMargin) ? fmtNum(d.profitMargin, 1) + '%' : '\u2014' },
    { label: 'Current ratio at or above 1', test: isNum(d.currentRatio) ? (d.currentRatio >= 1) : null, value: isNum(d.currentRatio) ? fmtNum(d.currentRatio, 2) : '\u2014' },
    { label: 'Beta at or under 1.5', test: isNum(d.beta) ? (d.beta <= 1.5) : null, value: isNum(d.beta) ? fmtNum(d.beta, 2) : '\u2014' },
    { label: 'EPS growing next year', test: isNum(d.epsGrowthNextY) ? (d.epsGrowthNextY >= 0) : null, value: isNum(d.epsGrowthNextY) ? fmtPct(d.epsGrowthNextY) : '\u2014' },
    { label: 'No boom-bust pattern', test: (bb && bb.testable) ? !bb.fires : null, value: (bb && bb.testable) ? (bb.fires ? 'Pattern present' : 'None detected') : '\u2014' }
  ];
}

/* EPS trajectory: TTM actual + consensus forecasts; cliff = a later year
 * falls 10%+ below the running peak, or next year drops vs TTM. */
function epsTrajectory(d) {
  var pts = epsPoints(d);
  var warning = null;
  if (pts.length >= 2) {
    var peak = -Infinity, peakLabel = '';
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].eps > peak) { peak = pts[i].eps; peakLabel = pts[i].label; }
      else if (peak > 0 && pts[i].eps < peak * 0.90) {
        warning = 'Earnings cliff in consensus: EPS peaks at ' + fmtNum(peak) + ' (' + peakLabel +
          ') then falls to ' + fmtNum(pts[i].eps) + ' by ' + pts[i].label + ' (' +
          fmtPct((pts[i].eps / peak - 1) * 100) + '). Cheap multiples on peak earnings are how value traps happen — check whether the peak is cyclical.';
        break;
      }
    }
    if (!warning) {
      var pc = epsPossibleCliff(d);
      if (pc) {
        warning = 'Possible cliff — only 2 years of estimates. EPS explodes ' + fmtPct(pc.g1, 0) + ' next year (' + pc.fy1Label +
          '), then growth slows to ' + fmtPct(pc.g2, 0) + ' (' + pc.fy2Label + '). The peak may sit just past the forecast window, so this counts as a cliff.';
      }
    }
    if (!warning && pts[1].eps < pts[0].eps) {
      warning = 'Consensus has earnings falling next year (' + fmtNum(pts[0].eps) + ' → ' + fmtNum(pts[1].eps) +
        '). A low forward multiple on shrinking earnings is not the same as cheap.';
    }
  }
  return { points: pts, warning: warning };
}

/* ============================== SVG charts ============================== */
function barChartSVG(pts, w, h) {
  w = w || 640; h = h || 190;
  if (!pts.length) return '';
  var padB = 26, padT = 22, padX = 8;
  var max = Math.max.apply(null, pts.map(function (p) { return p.eps; }).concat([0]));
  var min = Math.min.apply(null, pts.map(function (p) { return p.eps; }).concat([0]));
  var span = (max - min) || 1;
  var bw = (w - padX * 2) / pts.length;
  var zeroY = padT + (max / span) * (h - padT - padB);
  // The TTM (actual) bar and the value labels use CSS variables
  // (--chart-actual / --chart-val) rather than baked-in hex: variables
  // follow the live theme, so switching dark/light after the chart is
  // drawn can never strand pale-on-white (or dark-on-black) paint. 
  var out = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="EPS trajectory chart">';
  out += '<line x1="' + padX + '" y1="' + zeroY + '" x2="' + (w - padX) + '" y2="' + zeroY + '" stroke="#d8c98f" stroke-width="1"/>';
  pts.forEach(function (p, i) {
    var bh = Math.abs(p.eps) / span * (h - padT - padB);
    var x = padX + i * bw + bw * 0.16, bwid = bw * 0.68;
    var y = p.eps >= 0 ? zeroY - bh : zeroY;
    var fillAttr = p.kind === 'actual' ? 'style="fill:var(--chart-actual)"' : 'fill="url(#goldGrad)"';
    out += '<rect x="' + x + '" y="' + y + '" width="' + bwid + '" height="' + Math.max(bh, 1.5) + '" rx="4" ' + fillAttr + '/>';
    var vy = p.eps >= 0 ? y - 5 : y + bh + 13;
    out += '<text x="' + (x + bwid / 2) + '" y="' + vy + '" text-anchor="middle" font-size="12.5" font-weight="800" style="fill:var(--chart-val)">' + fmtNum(p.eps, Math.abs(p.eps) >= 100 ? 0 : 2) + '</text>';
    out += '<text x="' + (x + bwid / 2) + '" y="' + (h - 8) + '" text-anchor="middle" font-size="11.5" font-weight="700" fill="#77705f">' + esc(p.label) + (p.kind === 'est' ? ' est' : '') + '</text>';
  });
  out += '<defs><linearGradient id="goldGrad" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0%" stop-color="#B46A11"/><stop offset="33%" stop-color="#D68D15"/>' +
    '<stop offset="68%" stop-color="#E7AC18"/><stop offset="99%" stop-color="#F8C73D"/></linearGradient></defs>';
  out += '</svg>';
  return out;
}
function lineChartSVG(closes, high52, w, h, startText) {
  w = w || 640; h = h || 170; startText = startText || '1 year ago';
  if (!closes || closes.length < 2) return '';
  var padT = 16, padB = 20, padX = 6;
  var max = Math.max.apply(null, closes), min = Math.min.apply(null, closes);
  if (isNum(high52)) max = Math.max(max, high52);
  var span = (max - min) || 1;
  var X = function (i) { return padX + i * (w - padX * 2) / (closes.length - 1); };
  var Y = function (v) { return padT + (max - v) / span * (h - padT - padB); };
  var pts = closes.map(function (c, i) { return X(i).toFixed(1) + ',' + Y(c).toFixed(1); }).join(' ');
  var out = '<svg class="px-chart" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Price chart">';
  if (isNum(high52)) {
    out += '<line x1="' + padX + '" y1="' + Y(high52) + '" x2="' + (w - padX) + '" y2="' + Y(high52) + '" stroke="#B46A11" stroke-width="1.4" stroke-dasharray="5 4"/>' +
      '<text x="' + (w - padX) + '" y="' + (Y(high52) - 4) + '" text-anchor="end" font-size="11" font-weight="800" fill="#B46A11">52-wk high ' + fmtNum(high52, 0) + '</text>';
  }
  out += '<polyline points="' + pts + '" fill="none" style="stroke:var(--chart-line)" stroke-width="2.2" stroke-linejoin="round"/>';
  out += '<text x="' + padX + '" y="' + (h - 5) + '" font-size="11" font-weight="700" fill="#77705f">' + startText + '</text>' +
    '<text x="' + (w - padX) + '" y="' + (h - 5) + '" text-anchor="end" font-size="11" font-weight="700" fill="#77705f">now · ' + fmtNum(closes[closes.length - 1]) + '</text>';
  out += '<g class="px-scrub" style="display:none"><line class="px-scrub-line" y1="' + padT + '" y2="' + (h - padB) + '" stroke-width="1" stroke-dasharray="4 4" style="stroke:var(--muted)"/>' +
    '<circle class="px-scrub-dot" r="4.6" style="fill:var(--chart-line)" stroke="#0d0d0f" stroke-width="1.6"/></g>' +
    '<rect class="px-scrub-zone" x="0" y="0" width="' + w + '" height="' + (h - padB + 4) + '" fill="transparent" style="touch-action:none"/>';
  out += '</svg>';
  return out;
}
/* Price-chart range state (1Y weekly; 5Y/10Y monthly, fetched lazily
 * on first tap and then kept on the record, so the quote cache carries
 * them across opens). */
var scRange = '1y';

async function ensureRangeHist(d, range) {
  var key = range === '5y' ? 'hist5' : 'hist10';
  var tsKey = key + 'Ts';
  if (d[key] && d[key].length >= 2) return true;
  try {
    var ch = await relayJSON('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(d.ticker) + '?range=' + range + '&interval=1mo');
    var res = ch && ch.chart && ch.chart.result && ch.chart.result[0];
    if (!res) return false;
    var rawCloses = (res.indicators && res.indicators.quote && res.indicators.quote[0].close) || [];
    var rawTs = res.timestamp || [];
    var closes = [], tsArr = [];
    rawCloses.forEach(function (c, i) { if (isNum(c)) { closes.push(c); tsArr.push(rawTs[i] || null); } });
    if (closes.length < 2) return false;
    d[key] = closes;
    d[tsKey] = tsArr;
    try {
      var cache = lsGet(CACHE_KEY, {});
      if (cache[d.ticker] && cache[d.ticker].data) {
        cache[d.ticker].data[key] = closes;
        cache[d.ticker].data[tsKey] = tsArr;
        lsSet(CACHE_KEY, cache);
      }
    } catch (e) {}
    return true;
  } catch (e) { return false; }
}

function renderScChart(d) {
  var box = $('sc-chart-box');
  if (!box) return;
  var range = scRange;
  document.querySelectorAll('[data-scrange]').forEach(function (b) {
    b.classList.toggle('on', b.getAttribute('data-scrange') === range);
  });
  var label = $('sc-range-label');
  if (label) label.textContent = range === '1y' ? '1 year' : (range === '5y' ? '5 years' : '10 years');
  var series = range === '1y' ? d.history : (range === '5y' ? d.hist5 : d.hist10);
  if (!series || series.length < 2) {
    if (d['histErr_' + range]) {
      box.innerHTML = '<div class="status err">Couldn\'t load the ' + (range === '5y' ? '5-year' : '10-year') + ' history. <button type="button" class="btn-mini" id="sc-chart-retry">Retry</button></div>';
      var rb = $('sc-chart-retry');
      if (rb) rb.addEventListener('click', function () { delete d['histErr_' + range]; renderScChart(d); });
      return;
    }
    box.innerHTML = '<div class="status"><span class="spinner"></span>Loading ' + (range === '5y' ? '5-year' : '10-year') + ' history\u2026</div>';
    ensureRangeHist(d, range).then(function (ok) {
      if (!ok) d['histErr_' + range] = true;
      if (lastStock === d) renderScChart(d);
    });
    return;
  }
  var startText = range === '1y' ? '1 year ago' : (range === '5y' ? '5 years ago' : '10 years ago');
  box.innerHTML = '<div id="sc-chart-read" class="pf-bench-read">Drag across the chart to see the price at any point.</div>' +
    '<div class="chart-wrap">' + lineChartSVG(series, range === '1y' ? d.high52 : null, 640, 170, startText) + '</div>';
  bindPriceScrub(d, range);
}

/* Drag scrubbing for the scorecard price chart: a dashed crosshair + dot
 * follow the finger, and a readout under the chart shows that week's
 * date, price, and change since the start of the window. */
function bindPriceScrub(d, range) {
  range = range || '1y';
  var wrap = $('score-result');
  var series = range === '5y' ? d.hist5 : (range === '10y' ? d.hist10 : d.history);
  var tsArr = range === '5y' ? d.hist5Ts : (range === '10y' ? d.hist10Ts : d.historyTs);
  if (!wrap || !series || series.length < 2) return;
  var svg = wrap.querySelector('.px-chart');
  var zone = svg ? svg.querySelector('.px-scrub-zone') : null;
  var grp = svg ? svg.querySelector('.px-scrub') : null;
  var read = $('sc-chart-read');
  if (!svg || !zone || !grp || !read) return;
  var closes = series, n = closes.length;
  var max = Math.max.apply(null, closes), min = Math.min.apply(null, closes);
  if (range === '1y' && isNum(d.high52)) max = Math.max(max, d.high52);
  var span = (max - min) || 1, padT = 16, padB = 20, padX = 6, W = 640, H = 170;
  var X = function (i) { return padX + i * (W - padX * 2) / (n - 1); };
  var Y = function (v) { return padT + (max - v) / span * (H - padT - padB); };
  var line = grp.querySelector('.px-scrub-line'), dot = grp.querySelector('.px-scrub-dot');
  var MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var scrubbing = false;
  function dateFor(i) {
    var ts = tsArr && tsArr[i];
    if (isNum(ts)) { var dt = new Date(ts * 1000); return MONS[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear(); }
    var back = new Date();
    if (range === '1y') back.setDate(back.getDate() - (n - 1 - i) * 7);
    else back.setMonth(back.getMonth() - (n - 1 - i));
    return MONS[back.getMonth()] + ' ' + back.getDate() + ', ' + back.getFullYear();
  }
  function scrubTo(clientX) {
    var rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    var sx = (clientX - rect.left) / rect.width * W;
    var i = Math.round((sx - padX) / (W - padX * 2) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    var x = X(i), y = Y(closes[i]);
    grp.style.display = '';
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    var chg = (closes[i] / closes[0] - 1) * 100;
    read.innerHTML = '<b class="pf-read-date">' + dateFor(i) + '</b> \u00b7 <b>' + fmtMoney(closes[i]) + '</b> \u00b7 <b class="' + (chg >= 0 ? 'up' : 'down') + '">' + fmtPct(chg) + '</b> since the start of the chart';
  }
  zone.addEventListener('pointerdown', function (e) { scrubbing = true; try { zone.setPointerCapture(e.pointerId); } catch (err) {} scrubTo(e.clientX); e.preventDefault(); });
  zone.addEventListener('pointermove', function (e) { if (scrubbing) scrubTo(e.clientX); });
  zone.addEventListener('pointerup', function () { scrubbing = false; });
  zone.addEventListener('pointercancel', function () { scrubbing = false; });
}

/* ============================== scorecard UI ============================== */
var lastStock = null;
function kvItem(k, v) { return '<div class="kv-item"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>'; }

/* ============================== SWOT (auto) ============================== */
/* A SWOT built from the numbers already on the scorecard — every bullet
 * cites the metric behind it. It reads figures, not news: company-specific
 * events (lawsuits, new rivals, regulation) can't appear here. */
function buildSwot(d) {
  var S = [], W = [], O = [], T = [];
  var sc = scoreStock(d);
  var traj = epsTrajectory(d);
  var pts = traj.points;
  // Implied growth between consecutive EPS points (TTM -> forecasts).
  var gs = [];
  for (var i = 1; i < pts.length; i++) {
    if (isNum(pts[i - 1].eps) && isNum(pts[i].eps) && pts[i - 1].eps > 0) {
      gs.push((pts[i].eps / pts[i - 1].eps - 1) * 100);
    }
  }
  // Strengths
  if (isNum(d.grossMargin) && d.grossMargin >= 50) S.push('Gross margin ' + fmtNum(d.grossMargin, 1) + '% — real pricing power; customers aren\'t buying on price alone.');
  if (isNum(d.roe) && d.roe >= 20) S.push('ROE ' + fmtNum(d.roe, 1) + '% — owners\' capital is working hard.');
  if (isNum(d.operMargin) && d.operMargin >= 20) S.push('Operating margin ' + fmtNum(d.operMargin, 1) + '% — the core business is solidly profitable.');
  var bestRev = Math.max(isNum(d.salesGrowthTTM) ? d.salesGrowthTTM : -Infinity, isNum(d.revGrowthQtr) ? d.revGrowthQtr : -Infinity);
  if (bestRev >= 15) S.push('Revenue growing ' + fmtPct(bestRev) + ' — demand is expanding, not just prices rising.');
  if (d.epsRecord && d.epsRecord.n >= 6 && d.epsRecord.beatPct >= 75) S.push('Beats EPS estimates ' + d.epsRecord.beatPct + '% of the time (last ' + d.epsRecord.n + ' quarters) — management tends to deliver.');
  if (isNum(d.debtEq) && d.debtEq <= 0.5) S.push('Light debt load (Debt/Equity ' + fmtNum(d.debtEq, 2) + ') — room to weather a downturn.');
  if (isNum(d.divYield) && d.divYield >= 2) S.push('Pays a ' + fmtNum(d.divYield, 2) + '% dividend — cash back while you wait.');
  if (isNum(d.marketCap) && d.marketCap >= 1e11) S.push('Large, established company (' + fmtCap(d.marketCap) + ' market cap) — liquid and widely followed.');
  // Weaknesses
  if (isNum(d.profitMargin) && d.profitMargin < 0) W.push('Currently unprofitable — net margin ' + fmtNum(d.profitMargin, 1) + '%.');
  if (isNum(d.debtEq) && d.debtEq >= 2) W.push('Heavy debt load (Debt/Equity ' + fmtNum(d.debtEq, 2) + ') — interest eats flexibility, and refinancing risk is real if rates stay high.');
  if (isNum(d.grossMargin) && d.grossMargin < 20) W.push('Thin gross margin ' + fmtNum(d.grossMargin, 1) + '% — little pricing power; cost rises land straight on profit.');
  if (isNum(d.epsGrowthTTM) && d.epsGrowthTTM < 0) W.push('EPS shrank ' + fmtPct(d.epsGrowthTTM) + ' over the last year.');
  if (isNum(d.revGrowthQtr) && d.revGrowthQtr < 0) W.push('Revenue fell ' + fmtPct(d.revGrowthQtr) + ' in the latest quarter vs a year earlier.');
  else if (isNum(d.salesGrowthTTM) && d.salesGrowthTTM < 3) W.push('Revenue barely growing — ' + fmtPct(d.salesGrowthTTM) + ' over the last year.');
  if (d.epsRecord && d.epsRecord.n >= 4 && d.epsRecord.missPct >= 40) W.push('Misses EPS estimates ' + d.epsRecord.missPct + '% of the time (last ' + d.epsRecord.n + ' quarters) — forecasts here are unreliable.');
  if (isNum(d.beta) && d.beta >= 1.8) W.push('Beta ' + fmtNum(d.beta, 2) + ' — swings roughly ' + fmtNum(d.beta, 1) + '× the market, both ways. Position size matters.');
  // Opportunities
  if (isNum(d.pctBelowHigh) && d.pctBelowHigh >= 25 && sc.score != null && sc.score >= 55) O.push(fmtNum(d.pctBelowHigh, 1) + '% below its 52-week high while the scorecard still rates it ' + sc.score + '/100 — a possible price dislocation.');
  if (isNum(d.target1Y) && isNum(d.price) && d.price > 0 && d.target1Y > d.price * 1.1) O.push('Analysts\' 1-yr target (' + fmtMoney(d.target1Y) + ') implies ' + fmtPct((d.target1Y / d.price - 1) * 100) + ' upside from here.');
  if (gs.length >= 2) {
    var avgG = gs.reduce(function (a, b) { return a + b; }, 0) / gs.length;
    if (avgG >= 15) O.push('Consensus sees EPS compounding ~' + fmtNum(avgG, 0) + '%/yr (' + pts[0].label + ' ' + fmtNum(pts[0].eps) + ' → ' + pts[pts.length - 1].label + ' ' + fmtNum(pts[pts.length - 1].eps) + ').');
  }
  if (isNum(d.peg) && d.peg < 1 && isNum(d.epsGrowth5Y) && d.epsGrowth5Y >= 10) O.push('PEG ' + fmtNum(d.peg, 2) + ' — the market isn\'t fully pricing the expected ~' + fmtNum(d.epsGrowth5Y, 0) + '%/yr growth.');
  if (isNum(d.revGrowthQtr) && isNum(d.salesGrowthTTM) && d.revGrowthQtr > d.salesGrowthTTM + 3) O.push('Revenue growth is accelerating — latest quarter ' + fmtPct(d.revGrowthQtr) + ' vs ' + fmtPct(d.salesGrowthTTM) + ' trailing.');
  // Threats
  var peak = -Infinity, peakLabel = '', cliff = null;
  for (var j = 0; j < pts.length; j++) {
    if (isNum(pts[j].eps) && pts[j].eps > peak) { peak = pts[j].eps; peakLabel = pts[j].label; }
    else if (peak > 0 && isNum(pts[j].eps) && pts[j].eps < peak * 0.90) { cliff = pts[j]; break; }
  }
  if (cliff) T.push('Earnings cliff in consensus — EPS peaks at ' + fmtNum(peak) + ' (' + peakLabel + '), then falls to ' + fmtNum(cliff.eps) + ' by ' + cliff.label + '.');
  else if (epsPossibleCliff(d)) { var pcT = epsPossibleCliff(d); T.push('Possible earnings cliff — only 2 years of estimates: EPS explodes ' + fmtPct(pcT.g1, 0) + ' in ' + pcT.fy1Label + ', then growth slows to ' + fmtPct(pcT.g2, 0) + ' in ' + pcT.fy2Label + '. The peak may sit just past the forecast window, so this counts as a cliff.'); }
  else if (pts.length >= 2 && isNum(pts[1].eps) && isNum(pts[0].eps) && pts[1].eps < pts[0].eps) T.push('Consensus expects EPS to fall next year (' + fmtNum(pts[0].eps) + ' → ' + fmtNum(pts[1].eps) + ').');
  if (isNum(d.revGrowthQtr) && isNum(d.salesGrowthTTM) && d.revGrowthQtr < d.salesGrowthTTM - 3) T.push('Revenue growth is decelerating — latest quarter ' + fmtPct(d.revGrowthQtr) + ' vs ' + fmtPct(d.salesGrowthTTM) + ' trailing.');
  if (isNum(d.epsGrowthTTM) && d.epsGrowthTTM >= 60 && isNum(d.forwardPE) && d.forwardPE <= 12) T.push('Earnings look cyclically hot — EPS up ' + fmtPct(d.epsGrowthTTM) + ' in a year rarely lasts, and peak earnings make the P/E look deceptively cheap.');
  if (isNum(d.forwardPE) && d.forwardPE >= 35) T.push('Rich valuation (forward P/E ' + fmtNum(d.forwardPE, 1) + ') — priced for perfection; any miss hurts.');
  if (isNum(d.peg) && d.peg >= 2) T.push('PEG ' + fmtNum(d.peg, 2) + ' — paying a lot for the growth that\'s expected.');
  if (isNum(d.pctBelowHigh) && d.pctBelowHigh >= 45) T.push('Down ' + fmtNum(d.pctBelowHigh, 1) + '% from its 52-week high — a fall that deep can signal structural problems, not just a sale.');
  var cap4 = function (a) { return a.slice(0, 4); };
  return { S: cap4(S), W: cap4(W), O: cap4(O), T: cap4(T) };
}
function swotBox(letter, title, items, cls) {
  var lis = items.length
    ? items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('')
    : '<li>Nothing stands out in the data.</li>';
  return '<div class="swot-box ' + cls + '"><h5><span class="swot-badge">' + letter + '</span>' + esc(title) + '</h5><ul>' + lis + '</ul></div>';
}

/* ============================== AI SWOT ============================== */
/* Classic qualitative SWOT generated on demand by the Llama 4 model on
 * the user's own Cloudflare Worker (/swot endpoint, Workers AI free
 * tier). The app sends the ticker plus a summary of the live metrics it
 * already fetched; the worker adds recent Yahoo headlines and returns
 * the four lists. Saved on-device per ticker so it persists. */
var AI_SWOT_URL = 'https://stock-research-relay.supplessayings-6e6.workers.dev/swot';
var AI_SWOT_KEY = 'sr_aiswot_v1';

function getAiSwot(ticker) {
  var all = lsGet(AI_SWOT_KEY, {});
  return all[ticker] || null;
}
function saveAiSwot(ticker, entry) {
  var all = lsGet(AI_SWOT_KEY, {});
  all[ticker] = entry;
  lsSet(AI_SWOT_KEY, all);
}
function aiMetricsText(d) {
  var sc = scoreStock(d);
  var parts = [];
  if (isNum(d.marketCap)) parts.push('market cap ' + fmtCap(d.marketCap));
  if (isNum(d.forwardPE)) parts.push('forward P/E ' + fmtNum(d.forwardPE, 1));
  if (isNum(d.pe)) parts.push('trailing P/E ' + fmtNum(d.pe, 1));
  if (isNum(d.peg)) parts.push('PEG ' + fmtNum(d.peg, 2));
  if (isNum(d.grossMargin)) parts.push('gross margin ' + fmtNum(d.grossMargin, 1) + '%');
  if (isNum(d.operMargin)) parts.push('operating margin ' + fmtNum(d.operMargin, 1) + '%');
  if (isNum(d.profitMargin)) parts.push('profit margin ' + fmtNum(d.profitMargin, 1) + '%');
  if (isNum(d.roe)) parts.push('ROE ' + fmtNum(d.roe, 1) + '%');
  if (isNum(d.debtEq)) parts.push('debt/equity ' + fmtNum(d.debtEq, 2));
  if (isNum(d.beta)) parts.push('beta ' + fmtNum(d.beta, 2));
  if (isNum(d.salesGrowthTTM)) parts.push('revenue growth (TTM) ' + fmtPct(d.salesGrowthTTM));
  if (isNum(d.revGrowthQtr)) parts.push('revenue growth latest quarter ' + fmtPct(d.revGrowthQtr));
  if (isNum(d.epsGrowthTTM)) parts.push('EPS growth (TTM) ' + fmtPct(d.epsGrowthTTM));
  var traj = epsTrajectory(d);
  if (traj.points.length >= 2) {
    parts.push('consensus EPS path: ' + traj.points.map(function (p) { return p.label + ' ' + fmtNum(p.eps); }).join(' -> '));
  }
  if (traj.warning) parts.push('note: ' + traj.warning);
  if (d.epsRecord && d.epsRecord.n >= 4) {
    parts.push('EPS beat rate ' + d.epsRecord.beatPct + '% / miss rate ' + d.epsRecord.missPct + '% over last ' + d.epsRecord.n + ' quarters');
  }
  if (isNum(d.divYield)) parts.push('dividend yield ' + fmtNum(d.divYield, 2) + '%');
  return parts.join('; ') + '.';
}
function aiSwotGridHtml(entry) {
  return '<div class="swot-grid">' +
    swotBox('S', 'Strengths', entry.swot.S, 'sw-s') + swotBox('W', 'Weaknesses', entry.swot.W, 'sw-w') +
    swotBox('O', 'Opportunities', entry.swot.O, 'sw-o') + swotBox('T', 'Threats', entry.swot.T, 'sw-t') + '</div>' +
    '<p class="fineprint">AI-generated ' + esc(entry.asOf || '') + ' by Llama 4 on your Cloudflare account, from the live numbers above, recent headlines' + (entry.tenk ? ', and the Risk Factors section of its most recent 10-K (filed ' + esc(entry.tenk.filed) + ')' : '') + '. Strengths/Weaknesses are internal to the company; Opportunities/Threats are external factors. AI can be wrong or out of date — a starting point, not gospel. <button class="btn-ghost" id="ai-swot-btn" type="button">↻ Regenerate</button></p>';
}
function bindAiSwotBtn(d) {
  var b = $('ai-swot-btn');
  if (b) b.addEventListener('click', function () { runAiSwot(d); });
}
async function runAiSwot(d) {
  var zone = $('ai-swot-zone');
  if (!zone) return;
  zone.innerHTML = '<p class="fineprint"><span class="spinner"></span>Writing the SWOT — the AI is reading the numbers, recent headlines and the 10-K risk factors; give it up to ~30 seconds…</p>';
  try {
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 90000) : null;
    var resp = await fetch(AI_SWOT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: d.ticker,
        name: d.companyName || d.ticker,
        sector: d.sector || '',
        industry: d.industry || '',
        metrics: aiMetricsText(d)
      }),
      signal: ctrl ? ctrl.signal : undefined
    });
    if (timer) clearTimeout(timer);
    var data = await resp.json();
    if (!resp.ok || !data.swot) throw new Error((data && data.error) || ('HTTP ' + resp.status));
    var entry = { asOf: data.asOf || '', swot: data.swot, tenk: data.tenk || null };
    saveAiSwot(d.ticker, entry);
    var z2 = $('ai-swot-zone');
    if (z2) { z2.innerHTML = aiSwotGridHtml(entry); bindAiSwotBtn(d); }
  } catch (e) {
    var z3 = $('ai-swot-zone');
    if (z3) {
      z3.innerHTML = '<div class="alert warn">The AI SWOT didn\'t come back (' + esc(e.message || 'network error') + '). <button class="btn-ghost" id="ai-swot-btn" type="button">Try again</button></div>';
      bindAiSwotBtn(d);
    }
  }
}

function renderScorecard(d) {
  lastStock = d;
  var sc = scoreStock(d);
  var screen = valueScreen(d);
  var traj = epsTrajectory(d);
  var passCount = screen.filter(function (s) { return s.test === true; }).length;
  var knownCount = screen.filter(function (s) { return s.test !== null; }).length;
  var vClass = sc.verdict === 'Undervalued' ? 'undervalued' : sc.verdict === 'Fairly valued' ? 'fair' : 'overpriced';
  var chgCls = isNum(d.dayChangePct) ? (d.dayChangePct >= 0 ? 'up' : 'down') : '';
  var html = '<div class="card">';
  html += '<div class="sc-head"><div><div class="sc-name">' + esc(d.companyName || d.ticker) + ' <span class="gold-text">' + esc(d.ticker) + '</span></div>' +
    '<div class="sc-sub">' + esc([d.exchange, d.sector, d.industry].filter(Boolean).join(' · ')) + '</div></div>' +
    '<div class="sc-price"><div class="p">' + fmtMoney(d.price) + '</div>' +
    '<div class="chg ' + chgCls + '">' + (isNum(d.dayChangePct) ? fmtPct(d.dayChangePct) + ' today' : '') + '</div></div></div>';

  if (sc.score != null) {
    html += '<div class="verdict ' + vClass + '"><div><div class="v-label">Valuation verdict</div>' +
      '<div class="v-word">' + esc(sc.verdict) + '</div></div>' +
      '<div class="v-score">' + sc.score + '<small> / 100</small></div></div>';
    html += '<div class="score-bar"><div style="width:' + sc.score + '%"></div></div>';
    html += '<table class="factors"><tr><th>Factor</th><th>Value</th><th class="num">Points</th></tr>';
    sc.factors.forEach(function (f) {
      html += '<tr><td><strong>' + esc(f.name) + '</strong><div class="factor-note">' + esc(f.note) + '</div></td><td>' + esc(f.display) + '</td><td class="num"><strong>' + f.pts + '</strong> / ' + f.max + '</td></tr>';
    });
    html += '</table>';
    if (sc.maxAvailable < 100) {
      html += '<p class="fineprint">Score is scaled to 100 over the ' + sc.factors.length + ' factors with available data (' + sc.maxAvailable + ' pts possible). Missing data is never guessed.</p>';
    }
  } else {
    html += '<div class="alert warn">Not enough data came back to score this stock. The key stats below show what was found.</div>';
  }

  var rk = riskScore(d);
  if (rk.score != null) {
    var rClass = rk.score <= 25 ? 'risk-low' : rk.score <= 45 ? 'risk-mod' : rk.score <= 65 ? 'risk-elev' : 'risk-high';
    html += '<div class="verdict ' + rClass + '"><div><div class="v-label">Risk score</div>' +
      '<div class="v-word">' + esc(rk.verdict) + '</div></div>' +
      '<div class="v-score">' + rk.score + '<small> / 100</small></div></div>';
    html += '<div class="score-bar risk-bar"><div style="width:' + rk.score + '%"></div></div>';
    html += '<table class="factors"><tr><th>Risk factor</th><th>Value</th><th class="num">Risk pts</th></tr>';
    rk.factors.forEach(function (f) {
      html += '<tr><td><strong>' + esc(f.name) + '</strong><div class="factor-note">' + esc(f.note) + '</div></td><td>' + esc(f.display) + '</td><td class="num"><strong>' + f.pts + '</strong> / ' + f.max + '</td></tr>';
    });
    html += '</table>';
    html += '<p class="fineprint">Higher = riskier. Scaled to 100 over the ' + rk.factors.length + ' factors with available data (' + rk.maxAvailable + ' pts possible).</p>';
  }

  html += '<div class="section-h">Your value screen — <span class="gold-text">' + passCount + ' of ' + knownCount + '</span></div>';
  html += '<div class="screen-chips">';
  screen.forEach(function (s) {
    var cls = s.test === null ? '' : s.test ? 'pass' : 'fail';
    var mark = s.test === null ? '?' : s.test ? '✓ PASS' : '✗';
    html += '<div class="chip ' + cls + '"><span>' + esc(s.label) + '<br><span class="factor-note">' + esc(s.value) + '</span></span><span class="mark">' + mark + '</span></div>';
  });
  html += '</div>';

  var rScreen = riskScreen(d);
  var rKnown = rScreen.filter(function (s) { return s.test !== null; }).length;
  var rPass = rScreen.filter(function (s) { return s.test === true; }).length;
  html += '<div class="section-h">Risk screen — <span class="gold-text">' + rPass + ' of ' + rKnown + ' clear</span></div>';
  html += '<div class="screen-chips">';
  rScreen.forEach(function (s) {
    var cls = s.test === null ? '' : s.test ? 'pass' : 'fail';
    var mark = s.test === null ? '?' : s.test ? '\u2713 CLEAR' : '\u2717 FLAG';
    html += '<div class="chip ' + cls + '"><span>' + esc(s.label) + '<br><span class="factor-note">' + esc(s.value) + '</span></span><span class="mark">' + mark + '</span></div>';
  });
  html += '</div>';

  html += '<div class="section-h">Key <span class="gold-text">stats</span></div><div class="kv-grid">';
  html += kvItem('Market cap', fmtCap(d.marketCap));
  html += kvItem('Forward P/E', isNum(d.forwardPE) ? fmtNum(d.forwardPE, 2) + (d.forwardPECalc ? ' (calc.)' : '') : '—');
  html += kvItem('P/E (trailing)', isNum(d.pe) ? fmtNum(d.pe, 2) : '—');
  html += kvItem('PEG', isNum(d.peg) ? fmtNum(d.peg, 2) + (d.pegCalc ? ' (calc.)' : '') : '—');
  html += kvItem('EPS (trailing)', isNum(d.epsTTM) ? fmtNum(d.epsTTM) : '—');
  html += kvItem('EPS growth next yr', isNum(d.epsGrowthNextY) ? fmtPct(d.epsGrowthNextY) : '—');
  if (d.epsRecord && d.epsRecord.n >= 4) {
    html += kvItem('EPS miss rate · last ' + d.epsRecord.n + ' qtrs', d.epsRecord.missPct + '%');
    html += kvItem('EPS beat rate · last ' + d.epsRecord.n + ' qtrs', d.epsRecord.beatPct + '%');
  }
  html += kvItem('Revenue growth (TTM)', isNum(d.salesGrowthTTM) ? fmtPct(d.salesGrowthTTM) : '—');
  if (isNum(d.revGrowthQtr)) {
    html += kvItem('Revenue growth (latest qtr)', fmtPct(d.revGrowthQtr));
  }
  html += kvItem('Gross margin', isNum(d.grossMargin) ? fmtNum(d.grossMargin, 1) + '%' : '—');
  html += kvItem('Operating margin', isNum(d.operMargin) ? fmtNum(d.operMargin, 1) + '%' : '—');
  html += kvItem('Profit margin', isNum(d.profitMargin) ? fmtNum(d.profitMargin, 1) + '%' : '—');
  html += kvItem('Debt / Equity', isNum(d.debtEq) ? fmtNum(d.debtEq, 2) : '—');
  html += kvItem('ROE', isNum(d.roe) ? fmtNum(d.roe, 1) + '%' : '—');
  html += kvItem('Beta', isNum(d.beta) ? fmtNum(d.beta, 2) : '—');
  html += kvItem('52-wk range', (isNum(d.low52) ? fmtNum(d.low52, 0) : '—') + ' – ' + (isNum(d.high52) ? fmtNum(d.high52, 0) : '—'));
  html += kvItem('Below 52-wk high', isNum(d.pctBelowHigh) ? fmtNum(d.pctBelowHigh, 1) + '%' : '—');
  html += kvItem('Dividend yield', isNum(d.divYield) ? fmtNum(d.divYield, 2) + '%' : '—');
  html += kvItem('Analyst 1-yr target', isNum(d.target1Y) ? fmtMoney(d.target1Y) : '—');
  html += '</div>';

  var profitWarn = epsProfitWarning(d);
  if (profitWarn) html += '<div class="alert warn">⚠ ' + esc(profitWarn) + '</div>';

  html += '<div class="section-h">EPS trajectory — <span class="gold-text">cliff check</span></div>';
  if (traj.points.length >= 2) {
    html += '<div class="chart-wrap">' + barChartSVG(traj.points) + '</div>';
    if (traj.warning) html += '<div class="alert warn">⚠ ' + esc(traj.warning) + '</div>';
    else html += '<div class="alert ok">✓ No cliff in the consensus path — estimates don\'t fall off a peak inside the forecast window. That doesn\'t make it safe; it means the cheapness isn\'t obviously a peak-earnings illusion.</div>';
  } else {
    html += '<p class="fineprint">Not enough EPS data came back to run the cliff check for this ticker.</p>';
  }

  var aiSaved = getAiSwot(d.ticker);
  html += '<div class="section-h">Classic SWOT — <span class="gold-text">AI</span></div><div id="ai-swot-zone">';
  if (aiSaved && aiSaved.swot) {
    html += aiSwotGridHtml(aiSaved);
  } else {
    html += '<p class="fineprint">Written on demand by an AI (Llama 4, running free on your own Cloudflare account) from the live numbers on this page plus recent headlines — the qualitative side the numbers can\'t show: brand, rivals, regulation. Classic rules: Strengths and Weaknesses are internal to the company; Opportunities and Threats are external factors.</p>' +
      '<button class="btn-ghost" id="ai-swot-btn" type="button">✦ Generate AI SWOT</button>';
  }
  html += '</div>';

  var swot = buildSwot(d);
  html += '<div class="section-h">SWOT — <span class="gold-text">from the numbers</span></div>';
  html += '<div class="swot-grid">' +
    swotBox('S', 'Strengths', swot.S, 'sw-s') + swotBox('W', 'Weaknesses', swot.W, 'sw-w') +
    swotBox('O', 'Opportunities', swot.O, 'sw-o') + swotBox('T', 'Threats', swot.T, 'sw-t') + '</div>';
  html += '<p class="fineprint">Auto-generated from the figures on this page — it reads the numbers, not the news, so company-specific events (lawsuits, new rivals, regulation) won\'t show up here.</p>';

  if (d.history && d.history.length >= 2) {
    html += '<div class="section-h">Price — <span class="gold-text" id="sc-range-label">1 year</span></div>' +
      '<div class="sc-range-chips"><button type="button" data-scrange="1y" class="on">1Y</button><button type="button" data-scrange="5y">5Y</button><button type="button" data-scrange="10y">10Y</button></div>' +
      '<div id="sc-chart-box"></div>';
  }

  html += '<div class="sc-actions">' +
    '<button class="btn-ghost" id="sc-watch" type="button">◎ Add to watchlist</button>' +
    '<button class="btn-ghost" id="sc-journal" type="button">✎ Journal this stock</button>' +
    '<button class="btn-ghost" id="sc-project" type="button">✦ Project it</button>' +
    '<button class="btn-ghost" id="sc-refresh" type="button">↻ Refresh data</button></div>';

  var when = d.fetchedAt ? new Date(d.fetchedAt).toLocaleString() : '';
  if (d.partial) html += '<div class="alert warn">Fast data is in — still pulling valuation details (forward P/E, PEG, margins)… the score updates when they land.</div>';
  html += '<p class="src-line">Sources: ' + esc(d.sources.join(', ') || '—') + ' · Fetched ' + esc(when) + (d.fromCache ? ' (cached, ≤15 min old)' : '') +
    (d.route ? ' · Route: ' + esc(d.route === 'public relay' ? 'public relay (backup)' : d.route) : '') +
    '. Figures can differ slightly between sources and from your broker. Research tool, not financial advice.</p>';
  html += '</div>';
  $('score-result').innerHTML = html;
  $('score-empty').style.display = 'none';

  bindAiSwotBtn(d);
  document.querySelectorAll('[data-scrange]').forEach(function (b) {
    b.addEventListener('click', function () { scRange = b.getAttribute('data-scrange'); renderScChart(d); });
  });
  renderScChart(d);
  $('sc-watch').addEventListener('click', function () {
    addToWatchlist(d.ticker, isNum(d.price) ? d.price : null);
    switchTab('watchlist');
  });
  $('sc-journal').addEventListener('click', function () {
    switchTab('journal');
    startJournalEdit(d.ticker);
  });
  $('sc-project').addEventListener('click', function () {
    switchTab('tools');
    $('pj-ticker').value = d.ticker;
    fillProjection(d);
    runProjection();
    if (!isNum(d.pe5yAvg)) {
      pjEnsurePe5y(d).then(function () {
        if (isNum(d.pe5yAvg) && String($('pj-mult').value) === String(pjMultAuto) && ($('pj-ticker').value || '').trim().toUpperCase() === d.ticker) {
          $('pj-mult').value = Math.round(d.pe5yAvg * 10) / 10;
          pjMultAuto = $('pj-mult').value;
          pjPeNote = 'exit P/E = ' + (d.pe5yYears >= 5 ? '5-yr' : d.pe5yYears + '-yr') + ' avg P/E ' + fmtNum(d.pe5yAvg, 1) + '\u00d7';
          $('pj-status').textContent = 'Loaded ' + d.ticker + ' from the scorecard \u2014 ' + pjPeNote + '.';
          runProjection();
        }
      });
    }
  });
  $('sc-refresh').addEventListener('click', function () { runSearch(d.ticker, true); });
}

async function runSearch(ticker, fresh) {
  var T = String(ticker || '').trim().toUpperCase();
  if (!T) return;
  scRange = '1y';
  var status = $('score-status');
  status.className = 'status';
  status.innerHTML = '<span class="spinner"></span>Pulling live data for ' + esc(T) + '…';
  // Instant paint: if this ticker was looked up before, show the saved
  // data right away (even if stale) and refresh over the top — repeat
  // lookups feel instant instead of staring at a spinner in a relay wave.
  var staleHit = lsGet(CACHE_KEY, {})[T];
  var showedStale = false;
  if (staleHit && staleHit.data) {
    staleHit.data.fromCache = true;
    try { renderScorecard(staleHit.data); showedStale = true; } catch (e) {}
    if (showedStale) {
      status.innerHTML = '<span class="spinner"></span>Showing your last saved data for ' + esc(T) + ' — refreshing…';
    }
  }
  // The free relays fail in waves (rate limits, brief outages). Rather
  // than erroring on the first bad wave, retry the whole lookup a few
  // times with pauses — most waves clear within a minute.
  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      var d = await fetchStock(T, { fresh: !!fresh, onStage: function (interim) {
        status.innerHTML = '<span class="spinner"></span>Fast data for ' + esc(T) + ' is in — valuation details still coming…';
        renderScorecard(interim);
      } });
      status.textContent = '';
      renderScorecard(d);
      return;
    } catch (e) {
      if (attempt >= 3) {
        status.className = 'status err';
        status.textContent = showedStale
          ? 'Couldn\'t refresh ' + T + ' — the data routes are having a bad stretch. You\'re still seeing your last saved data above; try Refresh again in a minute.'
          : (e.message || 'Something went wrong fetching that ticker.') + ' (Tried 3 times — the data routes are having a bad stretch. Give it a minute and tap Research again.)';
        return;
      }
      status.innerHTML = '<span class="spinner"></span>A data route hiccuped — retrying automatically (' + attempt + ' of 3)…';
      await new Promise(function (res) { setTimeout(res, attempt * 1500); });
    }
  }
}

/* ============================== compare ============================== */
async function runCompare() {
  var tickers = [$('cmp-1').value, $('cmp-2').value, $('cmp-3').value]
    .map(function (v) { return v.trim().toUpperCase(); }).filter(Boolean);
  var status = $('compare-status');
  if (tickers.length < 2) { status.className = 'status err'; status.textContent = 'Enter at least two tickers to compare.'; return; }
  status.className = 'status';
  status.innerHTML = '<span class="spinner"></span>Fetching ' + tickers.join(', ') + '…';
  var results = [];
  for (var i = 0; i < tickers.length; i++) {
    try { results.push(await fetchStock(tickers[i])); }
    catch (e) { results.push({ ticker: tickers[i], error: e.message }); }
  }
  status.textContent = '';
  var ok = results.filter(function (r) { return !r.error; });
  if (!ok.length) { $('compare-result').innerHTML = '<div class="alert warn">None of those tickers loaded — the data routes may be busy. Try again in a moment.</div>'; return; }
  var rows = [
    { label: 'Price', get: function (d) { return d.price; }, fmt: function (v) { return fmtMoney(v); }, best: null },
    { label: 'Market cap', get: function (d) { return d.marketCap; }, fmt: fmtCap, best: 'max' },
    { label: 'Forward P/E ↓', get: function (d) { return d.forwardPE; }, fmt: function (v) { return fmtNum(v, 2); }, best: 'min' },
    { label: 'PEG ↓', get: function (d) { return d.peg; }, fmt: function (v) { return fmtNum(v, 2); }, best: 'min' },
    { label: 'Below 52-wk high', get: function (d) { return d.pctBelowHigh; }, fmt: function (v) { return fmtNum(v, 1) + '%'; }, best: 'max' },
    { label: 'EPS growth next yr', get: function (d) { return d.epsGrowthNextY; }, fmt: function (v) { return fmtPct(v); }, best: 'max' },
    { label: 'Profit margin', get: function (d) { return d.profitMargin; }, fmt: function (v) { return fmtNum(v, 1) + '%'; }, best: 'max' },
    { label: 'Debt / Equity ↓', get: function (d) { return d.debtEq; }, fmt: function (v) { return fmtNum(v, 2); }, best: 'min' },
    { label: 'Value screen', get: function (d) { return valueScreen(d).filter(function (s) { return s.test === true; }).length; }, fmt: function (v) { return v + ' / 4'; }, best: 'max' },
    { label: 'Score', get: function (d) { return scoreStock(d).score; }, fmt: function (v) { return isNum(v) ? v + ' / 100' : '—'; }, best: 'max' }
  ];
  var html = '<div class="card"><table class="cmp"><tr><th></th>';
  ok.forEach(function (d) { html += '<th class="num">' + esc(d.ticker) + '</th>'; });
  html += '</tr>';
  rows.forEach(function (row) {
    var vals = ok.map(row.get);
    var bestIdx = -1;
    if (row.best) {
      var bestVal = row.best === 'min' ? Infinity : -Infinity;
      vals.forEach(function (v, i2) {
        if (isNum(v) && (row.best === 'min' ? v < bestVal : v > bestVal)) { bestVal = v; bestIdx = i2; }
      });
    }
    html += '<tr><td class="rowh">' + esc(row.label) + '</td>';
    vals.forEach(function (v, i2) {
      var isBest = i2 === bestIdx;
      html += '<td class="num' + (isBest ? ' best' : '') + '">' + (isBest ? '<span class="star">★</span> ' : '') + esc(row.fmt(v)) + '</td>';
    });
    html += '</tr>';
  });
  html += '</table><p class="fineprint">★ = strongest value on that row. Lower is better where marked ↓. Same scoring rubric as the Scorecard tab.</p></div>';
  $('compare-result').innerHTML = html;
}

/* ============================== tools ============================== */
/* Populate the Projection Builder from a fetched stock record:
 * current price, current (TTM) EPS, and the analysts' year-by-year EPS
 * forecast path (up to 5 years). Every year renders an editable EPS box
 * and an editable growth-% box; the two stay in sync — edit an EPS and
 * its growth recomputes, edit a growth % and that year's EPS recomputes. */
var pjPath = [];            // [{label:'FY2026', eps:1.42, extrapolated:bool}]
var pjPathFromForecast = false;
var PJ_KEY = 'sr_projections_v1';
function getProjections() { return lsGet(PJ_KEY, {}); }
function setProjections(p) { lsSet(PJ_KEY, p); }
/* The implied Base-case price of a saved projection, recomputed from its
 * stored EPS path (base case = the path as-is at the saved exit P/E). */
function pjSavedBase(T) {
  var s = getProjections()[T];
  if (!s || !isNum(s.baseEps) || !isNum(s.mult) || !Array.isArray(s.path)) return null;
  var off = (s.path.length && s.path[0].ttm) ? 1 : 0;
  var feps = pjCaseEps(s.baseEps, s.path.slice(0, (s.years || 3) + off), 0);
  return isNum(feps) ? feps * s.mult : null;
}
/* Base-case CAGR of a saved projection: implied end price vs the price at
 * save time, annualized over the saved horizon -- comparable across
 * projections even when they use different year counts. */
function pjSavedCagr(T) {
  var s = getProjections()[T];
  var fp = pjSavedBase(T);
  if (!s || !isNum(fp) || !isNum(s.price) || s.price <= 0 || !isNum(s.years) || s.years < 1 || fp <= 0) return null;
  return (Math.pow(fp / s.price, 1 / s.years) - 1) * 100;
}
function pjSaveCurrent() {
  var T = ($('pj-ticker').value || '').trim().toUpperCase();
  if (!T) { window.alert('Load a stock first -- a saved projection needs a ticker.'); return; }
  if (!isNum(parseFloat($('pj-price').value)) || !isNum(pjBaseEps()) || !isNum(parseFloat($('pj-mult').value))) {
    window.alert('Fill in price, EPS base and exit P/E before saving.'); return;
  }
  var all = getProjections();
  all[T] = {
    savedAt: new Date().toISOString(),
    price: parseFloat($('pj-price').value), baseEps: pjBaseEps(),
    flatGrowth: pjFlatGrowth(), years: pjYearsWanted(),
    mult: parseFloat($('pj-mult').value),
    path: JSON.parse(JSON.stringify(pjPath)), fromForecast: pjPathFromForecast
  };
  setProjections(all);
  renderPjSaved();
  runProjection();
}
function pjRestore(T) {
  var s = getProjections()[T];
  if (!s) return;
  $('pj-ticker').value = T;
  if (isNum(s.price)) $('pj-price').value = s.price;
  if (isNum(s.baseEps)) $('pj-eps').value = s.baseEps;
  if (isNum(s.flatGrowth)) $('pj-growth').value = s.flatGrowth;
  if (isNum(s.years)) $('pj-years').value = s.years;
  if (isNum(s.mult)) $('pj-mult').value = s.mult;
  pjPath = JSON.parse(JSON.stringify(s.path || []));
  pjPathFromForecast = !!s.fromForecast;
  renderPjPath();
  runProjection();
  var st = $('pj-status');
  st.className = 'status';
  st.textContent = 'Showing your saved projection for ' + T + ' (saved ' + String(s.savedAt || '').slice(0, 10) + '). Price and EPS are as saved -- load the ticker again any time for live numbers.';
}
function renderPjSaved() {
  var box = $('pj-saved');
  if (!box) return;
  var all = getProjections();
  var ts = Object.keys(all).sort();
  if (!ts.length) { box.innerHTML = ''; return; }
  // Collapsible (Justin's call, 2026-10-25): the list only grows, and
  // restoring is occasional — collapsed by default, state remembered.
  var open = !!lsGet('sr_pjsaved_open', false);
  box.innerHTML = '<button type="button" class="pj-saved-head" id="pj-saved-toggle"><span>Saved projections \u00b7 ' + ts.length + '</span><span class="pj-saved-chev">' + (open ? '\u25be' : '\u25b8') + '</span></button>' +
    (open ? ts.map(function (T) {
      var base = pjSavedBase(T);
      return '<div class="pf-buy-row"><button class="pf-buy-txt" data-pj-open="' + esc(T) + '"><span>' + esc(T) + '</span><span>saved ' + esc(String(all[T].savedAt || '').slice(0, 10)) + (isNum(base) ? ' \u00b7 Base ' + fmtMoney(base) : '') + '</span></button><button class="link-btn danger" data-pj-del="' + esc(T) + '">\u2715</button></div>';
    }).join('') : '');
  var tg = $('pj-saved-toggle');
  if (tg) tg.addEventListener('click', function () { lsSet('sr_pjsaved_open', !open); renderPjSaved(); });
  box.querySelectorAll('[data-pj-open]').forEach(function (b) {
    b.addEventListener('click', function () { pjRestore(b.getAttribute('data-pj-open')); });
  });
  box.querySelectorAll('[data-pj-del]').forEach(function (b) {
    b.addEventListener('click', function () {
      var a2 = getProjections();
      delete a2[b.getAttribute('data-pj-del')];
      setProjections(a2);
      renderPjSaved();
      runProjection();
    });
  });
}

function pjBaseEps() { var v = parseFloat($('pj-eps').value); return isNum(v) ? v : null; }
function pjYearsWanted() {
  var y = parseInt($('pj-years').value, 10);
  return isNum(y) ? Math.max(1, Math.min(5, y)) : 3;
}
function pjFlatGrowth() {
  var g = parseFloat($('pj-growth').value);
  return isNum(g) ? g : 15;
}
/* Extrapolated years fade from the last known growth toward the long-run
 * rate (the flat-growth box), closing half the remaining gap per year --
 * so a one-year spike like +84.6% cools off instead of repeating forever. */
function pjFadeGrowth(lastG, anchor) {
  if (!isNum(lastG)) return anchor;
  if (!isNum(anchor)) return lastG;
  return anchor + (lastG - anchor) / 2;
}
/* Growth % of each path year vs the prior year's EPS (year 1 vs base). */
function pjGrowths(base, path) {
  var out = [], prev = base;
  for (var i = 0; i < path.length; i++) {
    if (path[i].ttm) {
      // The TTM row IS the current position: its growth is the actual
      // trailing-twelve-month growth, a reported figure, not a step.
      out.push(isNum(path[i].growth) ? path[i].growth : null);
      prev = path[i].eps;
      continue;
    }
    out.push(isNum(prev) && prev !== 0 && isNum(path[i].eps) ? (path[i].eps / prev - 1) * 100 : null);
    prev = path[i].eps;
  }
  return out;
}
function pjTtmOffset() { return (pjPath.length && pjPath[0].ttm) ? 1 : 0; }
/* Pure case math: chain the EPS path with every year's growth shifted by
 * deltaPts and return the exit-year EPS. Exported for testing. */
function pjCaseEps(base, path, deltaPts) {
  var growths = pjGrowths(base, path);
  var eps = base;
  for (var i = 0; i < path.length; i++) {
    if (path[i].ttm) { if (isNum(path[i].eps)) eps = path[i].eps; continue; }
    var g = growths[i];
    if (!isNum(g) || !isNum(eps)) { eps = path[i].eps; continue; }
    eps = eps * (1 + (g + deltaPts) / 100);
  }
  return eps;
}
/* Grow the path to at least n years, extrapolating past the last known
 * year at that year's growth (or the flat fallback rate). */
function pjEnsureYears(n) {
  var base = pjBaseEps(), guard = 0;
  while (pjPath.length < n && guard++ < 5) {
    var prevEps = pjPath.length ? pjPath[pjPath.length - 1].eps : base;
    var growths = pjGrowths(base, pjPath);
    var lastG = growths.length ? growths[growths.length - 1] : null;
    var g = pjFadeGrowth(lastG, pjFlatGrowth());
    var yr = null;
    if (pjPath.length) {
      var m = String(pjPath[pjPath.length - 1].label).match(/(\d{4})/);
      if (m) yr = parseInt(m[1], 10) + 1;
    }
    pjPath.push({
      label: yr ? 'FY' + yr : 'Year ' + (pjPath.length + 1),
      eps: isNum(prevEps) ? +(prevEps * (1 + g / 100)).toFixed(4) : null,
      extrapolated: true
    });
  }
}
/* No analyst path available: synthesize the rows from the flat rate. */
function pjSynthPath(ttmRow) {
  pjPath = ttmRow ? [ttmRow] : [];
  pjPathFromForecast = false;
  var base = pjBaseEps(), g = pjFlatGrowth(), n = pjYearsWanted();
  var eps = base;
  for (var i = 0; i < n; i++) {
    eps = isNum(eps) ? eps * (1 + g / 100) : null;
    pjPath.push({ label: 'Year ' + (i + 1), eps: isNum(eps) ? +eps.toFixed(4) : null, extrapolated: false });
  }
}
function renderPjPath() {
  var box = $('pj-path');
  if (!box) return;
  var base = pjBaseEps();
  var n = pjYearsWanted() + pjTtmOffset();
  pjEnsureYears(n);
  var growths = pjGrowths(base, pjPath);
  var html = '';
  for (var i = 0; i < n; i++) {
    var row = pjPath[i];
    html += '<div class="pj-yrow"><div class="pj-ylab">' + esc(row.label) + (row.extrapolated && isNum(row.eps) ? ' *' : '') + '</div>' +
      '<label>EPS $<input data-pjeps="' + i + '" type="number" step="any" value="' + (isNum(row.eps) ? fmtNum(row.eps, 2) : '') + '"></label>' +
      '<label>Growth %<input data-pjg="' + i + '" type="number" step="any" value="' + (isNum(growths[i]) ? fmtNum(growths[i], 1) : '') + '"></label></div>';
  }
  box.innerHTML = html;
}
function onPjPathEdit(e) {
  var t = e.target;
  if (!t || !t.hasAttribute) return;
  var base = pjBaseEps();
  if (t.hasAttribute('data-pjeps')) {
    var i = parseInt(t.getAttribute('data-pjeps'), 10);
    var v = parseFloat(t.value);
    if (isNum(v) && pjPath[i]) {
      pjPath[i].eps = v; pjPath[i].extrapolated = false;
      if (pjPath[i].ttm) $('pj-eps').value = v;
      renderPjPath();
    }
  } else if (t.hasAttribute('data-pjg')) {
    var j = parseInt(t.getAttribute('data-pjg'), 10);
    var gv = parseFloat(t.value);
    if (pjPath[j] && pjPath[j].ttm) {
      if (isNum(gv)) { pjPath[j].growth = gv; renderPjPath(); }
      return;
    }
    var prev = j === 0 ? base : (pjPath[j - 1] ? pjPath[j - 1].eps : null);
    if (isNum(gv) && isNum(prev) && pjPath[j]) {
      pjPath[j].eps = +(prev * (1 + gv / 100)).toFixed(4);
      pjPath[j].extrapolated = false;
      renderPjPath();
    }
  }
}
var pjPeNote = '', pjMultAuto = null;
function fillProjection(d) {
  if (isNum(d.price)) $('pj-price').value = d.price;
  var base = isNum(d.epsTTM) ? d.epsTTM : (isNum(d.epsNextY) ? d.epsNextY :
    (d.epsForecasts && d.epsForecasts[0] ? d.epsForecasts[0].eps : null));
  if (isNum(base)) $('pj-eps').value = base;
  if (isNum(d.epsGrowth5Y)) $('pj-growth').value = Math.max(-20, Math.min(60, Math.round(d.epsGrowth5Y)));
  else if (isNum(d.epsGrowthNextY)) $('pj-growth').value = Math.round(Math.max(-20, Math.min(60, d.epsGrowthNextY)));
  // Exit P/E starts at the stock's 5-year average P/E (StockAnalysis
  // ratios history) — what the market has paid across a full cycle.
  // Falls back to the current trailing P/E when no usable history
  // exists; either way the box stays editable.
  pjPeNote = '';
  if (isNum(d.pe5yAvg) && d.pe5yAvg > 0) {
    $('pj-mult').value = Math.round(d.pe5yAvg * 10) / 10;
    pjMultAuto = $('pj-mult').value;
    pjPeNote = 'exit P/E = ' + (d.pe5yYears >= 5 ? '5-yr' : d.pe5yYears + '-yr') + ' avg P/E ' + fmtNum(d.pe5yAvg, 1) + '\u00d7';
  } else if (isNum(d.pe) && d.pe > 0) {
    $('pj-mult').value = Math.round(d.pe * 10) / 10;
    pjMultAuto = $('pj-mult').value;
    pjPeNote = 'exit P/E = current P/E ' + fmtNum(d.pe, 1) + '\u00d7 (no 5-yr history)';
  }
  // Year-by-year path: the first row is the current TTM position (EPS and
  // its actual TTM growth), then the analysts' forecast years, up to 5.
  var ttmRow = isNum(d.epsTTM) ? {
    label: 'TTM', eps: d.epsTTM,
    growth: isNum(d.epsGrowthTTM) ? d.epsGrowthTTM : null,
    ttm: true, extrapolated: false
  } : null;
  var fc = (d.epsForecasts || []).filter(function (r) { return r && isNum(r.eps); }).slice(0, 5);
  if (fc.length) {
    pjPathFromForecast = true;
    pjPath = (ttmRow ? [ttmRow] : []).concat(fc.map(function (r, i) {
      var ym = String(r.fiscalEnd || '').match(/(\d{4})/);
      return { label: ym ? 'FY' + ym[1] : 'Year ' + (i + 1), eps: r.eps, extrapolated: false };
    }));
  } else {
    pjSynthPath(ttmRow);
  }
  renderPjPath();
}
async function loadProjectionTicker() {
  var T = ($('pj-ticker').value || '').trim().toUpperCase();
  var status = $('pj-status');
  if (!T) { status.className = 'status err'; status.textContent = 'Type a ticker first.'; return; }
  status.className = 'status';
  status.innerHTML = '<span class="spinner"></span>Loading live data for ' + esc(T) + '…';
  try {
    var peP = fetchPe5yAvg(T).catch(function () { return null; });
    var d = await fetchStock(T);
    var pe5 = await peP;
    if (pe5) { d.pe5yAvg = pe5.avg; d.pe5yYears = pe5.years; }
    fillProjection(d);
    var bits = [];
    if (pjPeNote) bits.push(pjPeNote);
    if (isNum(d.price)) bits.push('price ' + fmtMoney(d.price));
    if (isNum(d.epsTTM)) bits.push('EPS (TTM) ' + fmtMoney(d.epsTTM));
    var fcBits = (d.epsForecasts || []).filter(function (r) { return r && isNum(r.eps); }).slice(0, 5);
    if (fcBits.length) bits.push('analyst EPS path ' + fcBits.map(function (r) { return fmtMoney(r.eps); }).join(' → '));
    if (isNum(d.epsGrowth5Y)) bits.push('analyst 5-yr EPS growth ' + fmtNum(d.epsGrowth5Y, 1) + '%/yr');
    else if (isNum(d.epsGrowthNextY)) bits.push('next-yr EPS growth ' + fmtNum(d.epsGrowthNextY, 1) + '%');
    status.textContent = 'Loaded ' + T + (bits.length ? ' — ' + bits.join(' · ') : '') + '. Adjust the assumptions below, then build.';
    runProjection();
  } catch (e) {
    status.className = 'status err';
    status.textContent = e.message || 'Could not load that ticker.';
  }
}
function runProjection() {
  var price = parseFloat($('pj-price').value);
  var base = pjBaseEps();
  var years = pjYearsWanted();
  var mult = parseFloat($('pj-mult').value);
  var out = $('pj-result');
  if (!isNum(price) || !isNum(base) || !isNum(mult)) {
    out.innerHTML = '<div class="alert warn">Fill in price, EPS base and exit P/E to build the projection.</div>'; return;
  }
  if (!pjPath.length) pjSynthPath();
  pjEnsureYears(years + pjTtmOffset());
  renderPjPath();
  var path = pjPath.slice(0, years + pjTtmOffset());
  var scen = [
    { name: 'Bear', d: -5, m: mult - 2, note: 'path −5 pts/yr' },
    { name: 'Base', d: 0, m: mult, note: 'your path' },
    { name: 'Bull', d: 5, m: mult + 2, note: 'path +5 pts/yr' }
  ];
  var html = '<table class="factors scen"><tr><th>Case</th><th>EPS in ' + years + 'y</th><th>Exit P/E</th><th class="num">Implied price</th><th class="num">Return</th><th class="num">CAGR</th></tr>';
  scen.forEach(function (s) {
    var feps = pjCaseEps(base, path, s.d);
    if (!isNum(feps)) {
      html += '<tr><td><strong>' + s.name + '</strong> <span class="factor-note">(' + s.note + ')</span></td><td>—</td><td>' + fmtNum(s.m, 1) + '×</td><td class="num">—</td><td class="num">—</td><td class="num">—</td></tr>';
      return;
    }
    var fp = feps * s.m;
    var ret = (fp / price - 1) * 100;
    var cagr = fp > 0 ? (Math.pow(fp / price, 1 / years) - 1) * 100 : -100;
    html += '<tr><td><strong>' + s.name + '</strong> <span class="factor-note">(' + s.note + ')</span></td><td>' + fmtMoney(feps) + '</td><td>' + fmtNum(s.m, 1) + '×</td>' +
      '<td class="num"><strong>' + fmtMoney(fp) + '</strong></td><td class="num ' + (ret >= 0 ? 'up' : 'down') + '">' + fmtPct(ret) + '</td><td class="num">' + fmtPct(cagr) + '</td></tr>';
  });
  var curT = ($('pj-ticker').value || '').trim().toUpperCase();
  var savedPj = curT ? getProjections()[curT] : null;
  html += '</table>';
  html += '<div class="pj-save-row"><button class="btn-gold" id="pj-save" type="button">' + (savedPj ? 'Update saved projection' : 'Save projection') + '</button>' +
    (savedPj
      ? '<span class="factor-note">Saved for ' + esc(curT) + ' on ' + esc(String(savedPj.savedAt || '').slice(0, 10)) + '</span><button class="link-btn danger" id="pj-del" type="button">Delete saved</button>'
      : '<span class="factor-note">' + (curT ? 'Saves these exact assumptions on this device. Open it later from the Watchlist or the saved list below.' : 'Load a stock above first -- saving needs a ticker.') + '</span>') + '</div>';
  out.innerHTML = html;
  var svB = $('pj-save'); if (svB) svB.addEventListener('click', pjSaveCurrent);
  var dlB = $('pj-del'); if (dlB) dlB.addEventListener('click', function () { var all = getProjections(); delete all[curT]; setProjections(all); renderPjSaved(); runProjection(); });
}
/* ================= Quarterly metrics tool =================
 * 12 reported quarters of fundamentals (StockAnalysis statement
 * pages, which normalize SEC filings), one metric at a time as a bar
 * chart. EPS also gets analyst-consensus bars for the next few
 * quarters (Nasdaq) — the only metric with a published quarterly
 * consensus; the rest are reported quarters only. */
var QM_KEY = 'sr_qmetrics_v1';
var qmMetric = 'revenue';
var qmFreq = 'q';
var qmStore = { ticker: null, q: null, y: null };
function qmData() { return qmStore[qmFreq]; }

function parseSAValueM(s) {
  if (s == null) return null;
  var t = String(s).replace(/[$,]/g, '').trim();
  if (!t || t === '-' || t === '\u2014') return null;
  var v = parseFloat(t);
  return isFinite(v) ? v : null;
}

function parseSAQuarterly(htmlIs, htmlCf, yearly) {
  var periods = null, byLabel = {};
  var head = yearly ? 'Fiscal Year' : 'Fiscal Quarter';
  [htmlIs, htmlCf].forEach(function (html) {
    if (!html) return;
    saTables(html).forEach(function (rows) {
      if (!rows.length || rows[0][0] !== head) return;
      if (!periods) {
        periods = rows[0].slice(1);
        if (yearly) periods = periods.filter(function (p) { return p !== 'TTM'; }).slice(0, 8);
        else periods = periods.slice(0, 12);
      }
      rows.slice(1).forEach(function (r) {
        if (byLabel[r[0]]) return;
        var vals = [];
        for (var i = 0; i < periods.length; i++) {
          var j = rows[0].indexOf(periods[i]);
          vals.push(j > 0 ? parseSAValueM(r[j]) : null);
        }
        byLabel[r[0]] = vals;
      });
    });
  });
  if (!periods) return null;
  function series(label, scale) {
    var raw = byLabel[label];
    if (!raw) return null;
    return raw.map(function (v) { return isNum(v) ? v * scale : null; }).reverse();
  }
  var M = 1e6;
  return {
    periods: periods.slice().reverse(),
    revenue: series('Revenue', M),
    grossProfit: series('Gross Profit', M),
    operIncome: series('Operating Income', M),
    netIncome: series('Net Income', M),
    eps: series('EPS (Diluted)', 1) || series('Earnings Per Share', 1),
    fcf: series('Free Cash Flow', M)
  };
}

function qmEstLabel(fiscalEnd) {
  var m = String(fiscalEnd || '').match(/^([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  return m ? m[1] + ' \u2019' + m[2].slice(2) : String(fiscalEnd || '');
}

/* Estimate bars continue the reported quarter sequence (last reported
 * Q3 2026 -> estimates Q4 2026, Q1 2027, ...), so every axis label is
 * the same short 'Qn \u2019YY' shape and 17 bars never collide. */
function qmNextQLabels(lastLabel, n) {
  var m = String(lastLabel || '').match(/Q([1-4])\s*(\d{4})/);
  if (!m) return null;
  var q = parseInt(m[1], 10), y = parseInt(m[2], 10), out = [];
  for (var i = 0; i < n; i++) { q++; if (q > 4) { q = 1; y++; } out.push('Q' + q + ' \u2019' + String(y).slice(2)); }
  return out;
}

async function fetchQMetrics(T, freq) {
  var yearly = freq === 'y';
  var cache = lsGet(QM_KEY, {});
  var day = new Date().toDateString();
  if (cache[T] && cache[T].day === day && cache[T][freq]) return cache[T][freq];
  var base = 'https://stockanalysis.com/stocks/' + encodeURIComponent(T) + '/financials/';
  var suffix = yearly ? '' : '?p=quarterly';
  var needle = yearly ? 'Fiscal Year' : 'Fiscal Quarter';
  var ok = function (t) { return t.indexOf(needle) !== -1; };
  var fcUrl = 'https://stockanalysis.com/stocks/' + encodeURIComponent(T) + '/forecast/';
  var pages = await Promise.all([
    relayFetch(base + 'income-statement/' + suffix, { timeout: 25000, validate: ok }).catch(function () { return null; }),
    relayFetch(base + suffix, { timeout: 25000, validate: ok }).catch(function () { return null; }),
    relayFetch(base + 'cash-flow-statement/' + suffix, { timeout: 25000, validate: ok }).catch(function () { return null; }),
    yearly ? relayFetch(fcUrl, { timeout: 25000, validate: function (t) { return t.indexOf('Period Ending') !== -1; } }).catch(function () { return null; }) : Promise.resolve(null)
  ]);
  var data = parseSAQuarterly(pages[0] || pages[1], pages[2], yearly);
  data.est = yearly ? parseSAForecastMetrics(pages[3]) : null;
  if (!data || !data.revenue) throw new Error('No ' + (yearly ? 'annual' : 'quarterly') + ' statements found for \u201c' + T + '\u201d.');
  data.estEps = [];
  try {
    var fc = await relayJSON('https://api.nasdaq.com/api/analyst/' + encodeURIComponent(T) + '/earnings-forecast?assetclass=stocks');
    var tbl = yearly ? (fc && fc.data && fc.data.yearlyForecast) : (fc && fc.data && fc.data.quarterlyForecast);
    var q = (tbl && tbl.rows) || [];
    data.estEps = q.map(function (r) {
      return { label: qmEstLabel(r.fiscalEnd), eps: typeof r.consensusEPSForecast === 'number' ? r.consensusEPSForecast : parseNum(r.consensusEPSForecast) };
    }).filter(function (r) { return isNum(r.eps); });
  } catch (e) {}
  data.ticker = T;
  if (!cache[T] || cache[T].day !== day) cache[T] = { day: day };
  cache[T][freq] = data;
  lsSet(QM_KEY, cache);
  return data;
}

function fmtMoneyShort(v) {
  if (!isNum(v)) return '\u2014';
  var sign = v < 0 ? '-' : '';
  return sign + fmtCap(Math.abs(v));
}

function qmShortQ(label) {
  return String(label || '').replace(/(\d{4})/, function (y) { return '\u2019' + y.slice(2); });
}

function qmBarsSVG(pts, fmt) {
  var w = 640, h = 224, padB = 34, padT = 32, padX = 6;
  var max = Math.max.apply(null, pts.map(function (p) { return p.value; }).concat([0]));
  var min = Math.min.apply(null, pts.map(function (p) { return p.value; }).concat([0]));
  var span = (max - min) || 1;
  var bw = (w - padX * 2) / pts.length;
  var zeroY = padT + (max / span) * (h - padT - padB);
  // Value labels scale with density: big and readable on sparse
  // charts, tighter when 17 bars share the width (Justin's ask,
  // 2026-10-26). Bars nearly touch for the same reason.
  var vfs = pts.length <= 8 ? 16.5 : pts.length <= 13 ? 14.5 : 12.5;
  var out = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Metric chart">';
  out += '<line x1="' + padX + '" y1="' + zeroY + '" x2="' + (w - padX) + '" y2="' + zeroY + '" stroke="#3a372d" stroke-width="1"/>';
  pts.forEach(function (p, i) {
    var x = padX + i * bw + bw * 0.03, bwid = bw * 0.94;
    var y = zeroY - (p.value / span) * (h - padT - padB);
    var top = Math.min(y, zeroY), bot = Math.max(y, zeroY);
    // Positive = green, negative = red, both with a soft glow
    // (Justin's ask, 2026-10-26); estimates keep their faded look.
    var col = p.value >= 0 ? 'var(--neon-up)' : 'var(--neon-dn)';
    var fill = p.kind === 'est'
      ? 'fill:' + col + ';opacity:.45;filter:drop-shadow(0 0 4px ' + col + ')'
      : 'fill:' + col + ';filter:drop-shadow(0 0 6px ' + col + ')';
    out += '<rect x="' + x.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bwid.toFixed(1) + '" height="' + Math.max(1.5, bot - top).toFixed(1) + '" rx="1.5" style="' + fill + '"/>';
    var ly = p.value >= 0 ? top - 8 : bot + vfs + 3;
    out += '<text x="' + (x + bwid / 2).toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="middle" font-size="' + vfs + '" font-weight="800" style="fill:var(--chart-val)">' + esc(fmt(p.value)) + '</text>';
    if (p.axis) {
      out += '<text x="' + (x + bwid / 2).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle" font-size="12" font-weight="700" fill="#8a8271">' + esc(p.axis) + '</text>';
    }
  });
  return out + '</svg>';
}

var QM_METRICS = {
  revenue: { name: 'Revenue', fmt: fmtMoneyShort, get: function (d, i) { return d.revenue && d.revenue[i]; } },
  netIncome: { name: 'Net income', fmt: fmtMoneyShort, get: function (d, i) { return d.netIncome && d.netIncome[i]; } },
  eps: { name: 'EPS (diluted)', fmt: function (v) { return '$' + fmtNum(v, 2); }, get: function (d, i) { return d.eps && d.eps[i]; } },
  fcf: { name: 'Free cash flow', fmt: fmtMoneyShort, get: function (d, i) { return d.fcf && d.fcf[i]; } },
  grossMargin: { name: 'Gross margin', fmt: function (v) { return fmtNum(v, 1) + '%'; }, get: function (d, i) { return (isNum(d.grossProfit && d.grossProfit[i]) && isNum(d.revenue && d.revenue[i]) && d.revenue[i] !== 0) ? d.grossProfit[i] / d.revenue[i] * 100 : null; } },
  operMargin: { name: 'Operating margin', fmt: function (v) { return fmtNum(v, 1) + '%'; }, get: function (d, i) { return (isNum(d.operIncome && d.operIncome[i]) && isNum(d.revenue && d.revenue[i]) && d.revenue[i] !== 0) ? d.operIncome[i] / d.revenue[i] * 100 : null; } },
  netMargin: { name: 'Net margin', fmt: function (v) { return fmtNum(v, 1) + '%'; }, get: function (d, i) { return (isNum(d.netIncome && d.netIncome[i]) && isNum(d.revenue && d.revenue[i]) && d.revenue[i] !== 0) ? d.netIncome[i] / d.revenue[i] * 100 : null; } }
};

function renderQm() {
  var d = qmData();
  if (!d) return;
  document.querySelectorAll('[data-qm]').forEach(function (b) {
    b.classList.toggle('on', b.getAttribute('data-qm') === qmMetric);
  });
  document.querySelectorAll('[data-qmfreq]').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-qmfreq') === qmFreq);
  });
  var M = QM_METRICS[qmMetric], pts = [];
  d.periods.forEach(function (p, i) {
    var v = M.get(d, i);
    if (isNum(v)) pts.push({ label: qmShortQ(p), value: v, kind: 'actual' });
  });
  // Sparse axis (Justin's ask): in quarterly view, mark only the first
  // bar of each year with the year; yearly view labels every bar.
  var lastYr = null;
  pts.forEach(function (p) {
    var ym = p.label.match(/(\d{4}|\u2019\d{2})/);
    var yr = ym ? ym[1] : p.label;
    if (qmFreq === 'y') { p.axis = p.label; lastYr = yr; }
    else if (yr !== lastYr) { p.axis = '\u2019' + String(yr).slice(-2); lastYr = yr; }
  });
  var estList = [];
  if (qmMetric === 'eps' && d.estEps && d.estEps.length) estList = d.estEps.map(function (e) { return { label: e.label, value: e.eps }; });
  else if (d.est && d.est[qmMetric] && d.est[qmMetric].length) estList = d.est[qmMetric];
  if (estList.length) {
    var lastP = d.periods[d.periods.length - 1];
    var seq = qmFreq === 'y' ? qmNextYLabels(lastP, estList.length) : qmNextQLabels(lastP, estList.length);
    estList.forEach(function (e, i) {
      var pt = { label: e.plabel ? qmShortQ(e.plabel) : ((seq && seq[i]) || e.label), value: e.value, kind: 'est' };
      var ym = pt.label.match(/(\d{4}|\u2019\d{2})/);
      var yr = ym ? ym[1] : pt.label;
      if (qmFreq === 'y') pt.axis = pt.label;
      else if (yr !== lastYr) { pt.axis = '\u2019' + String(yr).slice(-2); lastYr = yr; }
      pts.push(pt);
    });
  }
  var box = $('qm-chart');
  if (!pts.length) {
    box.innerHTML = '<div class="status err">No ' + esc(M.name) + ' data in the statements for ' + esc(d.ticker) + '.</div>';
  } else {
    box.innerHTML = '<div class="chart-wrap">' + qmBarsSVG(pts, M.fmt) + '</div>';
  }
  var per = qmFreq === 'y' ? 'years' : 'quarters';
  var hasEst = pts.some(function (p) { return p.kind === 'est'; });
  $('qm-note').textContent = !hasEst
    ? 'Reported ' + per + ' only \u2014 SEC filings via StockAnalysis. No free consensus is published for this metric in this view.'
    : qmMetric === 'eps'
      ? 'Solid bars: reported ' + per + ' (SEC filings via StockAnalysis). Faded bars: analyst consensus for the next few ' + per + ' (Nasdaq).'
      : 'Solid bars: reported years (SEC filings via StockAnalysis). Faded bars: analyst consensus for the current fiscal year (StockAnalysis) \u2014 deeper years are paywalled there, so only EPS runs further out (via Nasdaq). Quarterly consensus is published only for EPS.';
}

/* Yearly estimate labels continue the reported fiscal years:
 * last reported 'FY 2025' -> estimates 'FY \u201926', 'FY \u201927', ... */
function qmNextYLabels(lastLabel, n) {
  var m = String(lastLabel || '').match(/(\d{4})/);
  if (!m) return null;
  var y = parseInt(m[1], 10), fy = String(lastLabel).indexOf('FY') !== -1, out = [];
  for (var i = 0; i < n; i++) { y++; out.push((fy ? 'FY ' : '') + '\u2019' + String(y).slice(2)); }
  return out;
}

async function loadQm() {
  var T = String(($('qm-ticker').value || '')).trim().toUpperCase();
  if (!T) return;
  if (qmStore.ticker !== T) qmStore = { ticker: T, q: null, y: null };
  var st = $('qm-status');
  var yearly = qmFreq === 'y';
  try {
    if (!qmStore[qmFreq]) {
      st.innerHTML = '<span class="spinner"></span>Loading ' + (yearly ? 'annual' : 'quarterly') + ' statements for ' + esc(T) + '\u2026';
      qmStore[qmFreq] = await fetchQMetrics(T, qmFreq);
    }
    var d = qmData();
    st.textContent = d.ticker + ' \u00b7 last ' + d.periods.length + ' reported ' + (yearly ? 'years' : 'quarters');
    $('qm-body').hidden = false;
    renderQm();
  } catch (e) {
    $('qm-body').hidden = true;
    st.innerHTML = '<span class="status err">' + esc(e.message || 'Could not load data.') + '</span>';
  }
}

function runCompound() {
  var init = parseFloat($('cc-init').value) || 0;
  var monthly = parseFloat($('cc-monthly').value) || 0;
  var years = parseInt($('cc-years').value, 10) || 0;
  var rate = parseFloat($('cc-rate').value);
  var out = $('cc-result');
  if (!isNum(rate) || years < 1) { out.innerHTML = '<div class="alert warn">Enter a return rate and at least 1 year.</div>'; return; }
  var r = rate / 100 / 12, bal = init, series = [init], contributed = init;
  for (var m = 1; m <= years * 12; m++) {
    bal = bal * (1 + r) + monthly;
    contributed += monthly;
    if (m % 12 === 0) series.push(bal);
  }
  var gains = bal - contributed;
  // mini area chart
  var w = 640, h = 150, max = Math.max.apply(null, series.concat([contributed])), min = 0;
  var X = function (i) { return 6 + i * (w - 12) / (series.length - 1); };
  var Y = function (v) { return 8 + (max - v) / ((max - min) || 1) * (h - 34); };
  var pts = series.map(function (v, i) { return X(i).toFixed(1) + ',' + Y(v).toFixed(1); }).join(' ');
  var area = '6,' + (h - 26) + ' ' + pts + ' ' + X(series.length - 1).toFixed(1) + ',' + (h - 26);
  var svg = '<svg viewBox="0 0 ' + w + ' ' + h + '"><polygon points="' + area + '" fill="rgba(248,199,61,.35)"/>' +
    '<polyline points="' + pts + '" fill="none" stroke="#B46A11" stroke-width="2.4"/>' +
    '<text x="6" y="' + (h - 6) + '" font-size="11" font-weight="700" fill="#77705f">today</text>' +
    '<text x="' + (w - 6) + '" y="' + (h - 6) + '" text-anchor="end" font-size="11" font-weight="700" fill="#77705f">year ' + years + '</text></svg>';
  out.innerHTML = '<div class="tool-big">Worth ' + fmtMoney(bal, 0) + ' in ' + years + ' years</div>' +
    '<p class="fineprint" style="margin:6px 0 10px">You put in ' + fmtMoney(contributed, 0) + ' · growth adds ' + fmtMoney(gains, 0) +
    ' at ' + fmtNum(rate, 1) + '%/yr with monthly compounding.</p><div class="chart-wrap">' + svg + '</div>';
}

/* ============================== watchlist ============================== */
var WL_KEY = 'sr_watchlist_v1';
function getWatchlist() { return lsGet(WL_KEY, []); }
function setWatchlist(w) { lsSet(WL_KEY, w); }
function addToWatchlist(ticker, target) {
  var T = String(ticker || '').trim().toUpperCase();
  if (!T) return;
  var wl = getWatchlist();
  var existing = wl.filter(function (x) { return x.ticker === T; })[0];
  if (existing) { if (isNum(target)) existing.target = target; }
  else wl.push({ ticker: T, target: isNum(target) ? target : null, addedAt: Date.now() });
  setWatchlist(wl);
  renderWatchlist(true);
}
async function fetchLightPrice(T) {
  var cache = lsGet(CACHE_KEY, {});
  var hit = cache[T];
  if (hit && hit.data && isNum(hit.data.price) && (Date.now() - hit.ts) < CACHE_TTL) return hit.data.price;
  try {
    var info = await relayJSON('https://api.nasdaq.com/api/quote/' + encodeURIComponent(T) + '/info?assetclass=stocks');
    var p = parseNum(info && info.data && info.data.primaryData && info.data.primaryData.lastSalePrice);
    if (isNum(p)) return p;
  } catch (e) {}
  var d = await fetchStock(T);
  return d.price;
}

/* ---- watchlist valuation scores + sorting ---- */
var WLVAL_KEY = 'sr_wlval_v1';
var WLSORT_KEY = 'sr_wlsort_v1';
function getWlSort() {
  try { return localStorage.getItem(WLSORT_KEY) || 'added'; } catch (e) { return 'added'; }
}
/* Best available valuation for a watchlist row, synchronously: a recent
 * full scorecard fetch wins; otherwise the saved Finviz-only score. */
function wlValuationDisplay(T) {
  var cache = lsGet(CACHE_KEY, {});
  var hit = cache[T];
  if (hit && hit.data) {
    // Any cached scorecard record beats a blank line: show its score even
    // when stale (fresh=false still triggers the background refetch).
    var sc = scoreStock(hit.data);
    if (sc.score != null) {
      var rk = riskScore(hit.data);
      return { score: sc.score, verdict: sc.verdict, risk: rk.score, fresh: (Date.now() - hit.ts) < CACHE_TTL };
    }
  }
  var map = lsGet(WLVAL_KEY, {});
  var e = map[T];
  if (e && isNum(e.score)) return { score: e.score, verdict: e.verdict, risk: isNum(e.risk) ? e.risk : null, fresh: (Date.now() - (e.at || 0)) < 24 * 3600 * 1000 };
  return null;
}
/* Finviz-only valuation pass for the watchlist (one fetch per ticker). */
async function fetchWlValuation(T) {
  var d = { ticker: T, sources: [], errors: [] };
  try {
    var fvHtml = await relayFetch('https://finviz.com/stock?t=' + encodeURIComponent(T), {
      validate: function (t) { return t.indexOf('snapshot-td-label') !== -1; }
    });
    fillFromFinviz(d, fvHtml);
    if (isNum(d.epsNextY) && isNum(d.epsThisY) && d.epsThisY > 0) d.epsGrowthNextY = (d.epsNextY / d.epsThisY - 1) * 100;
  } catch (e) {}
  var sc = scoreStock(d);
  if (sc.score == null) return null;
  var rk = riskScore(d);
  return { score: sc.score, verdict: sc.verdict, risk: rk.score };
}

/* ============================== daily index scan ==============================
 * Once a day the app scans the whole S&P 500 and Russell 2000 for the
 * five best combined scores, using the same scoreStock() and
 * riskScore() as the scorecard: combined = 60% valuation + 40% safety
 * (100 - risk). His Cloudflare relay does the heavy lifting: its
 * /screen route extracts just the needed rows from Finviz's screener
 * pages (~2-4 KB per page instead of ~400 KB of HTML).
 *
 * PACING IS DELIBERATE (v2): Finviz rate-limits by IP — the relay's
 * egress included — and a 375-page burst earned 403s, which the first
 * version mistook for "page failed, drop it" and finalized a partial
 * scan as if it were complete. Now: 2 pages at a time with gaps,
 * a 25-second cool-down whenever the relay reports a Finviz block,
 * up to 5 tries per page, dropped pages remembered for Resume, and a
 * scan only counts as DONE when every page landed. Partial results
 * are labelled partial, with the true scored count. */
var SCAN_URL = 'https://stock-research-relay.supplessayings-6e6.workers.dev/screen';
var SCAN_VIEWS = ['121', '161', '171'];
var SCAN_IDXS = [
  { key: 'spx', label: 'S&P 500' },
  { key: 'rut', label: 'Russell 2000' }
];
var SCAN_KEY = 'sr_scan_v4';
var scanRunning = false, scanActive = 0, scanCoolUntil = 0, scanTimer = null;

function scanTodayKey() { return pfKeyToISO(pfDkey(new Date())); }
function scanFreshIdx(started) {
  // Option B (Justin's pick, 2026-10-26): the Russell 2000 is 297 of
  // the 375 daily pages, so only the S&P 500 auto-starts; the Russell
  // waits for the card's Scan button (started=false, empty queue).
  var ix = { total: null, merged: {}, pending: [], queued: {}, pages: 0, dropped: [], started: started !== false };
  if (ix.started) ix.pending = SCAN_VIEWS.map(function (v) { return [v, 1, 0]; });
  return ix;
}
function scanFreshState() {
  var s = { date: scanTodayKey(), done: false, partial: false, results: null, idx: {} };
  SCAN_IDXS.forEach(function (ix) { s.idx[ix.key] = scanFreshIdx(ix.key === 'spx'); });
  return s;
}
function scanStartIndex(ixKey) {
  var s = getScan();
  if (!s || s.date !== scanTodayKey()) { s = scanFreshState(); }
  var ix = s.idx[ixKey];
  if (!ix || ix.started) { setScan(s); return; }
  ix.started = true;
  ix.pending = SCAN_VIEWS.map(function (v) { return [v, 1, 0]; });
  s.done = false;
  s.partial = false;
  setScan(s);
  renderScanCard();
  scanPump();
}
function getScan() {
  try { var s = JSON.parse(localStorage.getItem(SCAN_KEY) || 'null'); return (s && s.idx) ? s : null; }
  catch (e) { return null; }
}
function setScan(s) { try { localStorage.setItem(SCAN_KEY, JSON.stringify(s)); } catch (e) {} }

function scanMerge(idxs, view, rows) {
  rows.forEach(function (row) {
    var rec = idxs.merged[row.t];
    if (!rec) { rec = { name: row.name || row.t }; idxs.merged[row.t] = rec; }
    var n = row.n || {};
    if (view === '121') {
      if (isNum(n.forwardPE)) rec.forwardPE = n.forwardPE;
      if (isNum(n.PEG)) rec.peg = n.PEG;
      if (isNum(n.epsYoY1)) rec.epsGrowthNextY = n.epsYoY1;
      if (isNum(n.price)) rec.price = n.price;
      // Finviz reports market cap in $millions; the risk score's size
      // bands (and fmtCap) work in raw dollars.
      if (isNum(n.marketCap)) rec.marketCap = n.marketCap * 1e6;
    } else if (view === '161') {
      if (isNum(n.grossMargin)) rec.grossMargin = n.grossMargin;
      if (isNum(n.netMargin)) rec.profitMargin = n.netMargin;
      if (isNum(n.debtEq)) rec.debtEq = n.debtEq;
      if (isNum(n.curRatio)) rec.currentRatio = n.curRatio;
    } else if (view === '171') {
      if (isNum(n.high52w)) rec.pctBelowHigh = Math.max(0, -n.high52w);
      if (isNum(n.beta)) rec.beta = n.beta;
    }
  });
}

function scanFinalizeIdx(idxs) {
  var out = [];
  Object.keys(idxs.merged).forEach(function (t) {
    var rec = idxs.merged[t];
    // Eligibility: a ranking score must rest on the anchor factor (a
    // real forward P/E) and at least 60 of the 100 factor points —
    // otherwise a name with two maxed-out minor factors (fresh
    // spin-offs, pre-revenue shells) normalizes to a meaningless 100.
    if (!(isNum(rec.forwardPE) && rec.forwardPE > 0)) return;
    var s = scoreStock(rec);
    if (!(s && isNum(s.score) && s.maxAvailable >= 60)) return;
    // The combined score's risk side needs the same grounding: the
    // screener-fed risk factors total 90 points (beta 10 + debt/eq 25
    // + profit margin 15 + size 15 + EPS trend 15 + current ratio 10;
    // the boom-bust factor needs a revenue path the screener doesn't
    // carry, so it never counts here). Require at least 60% of those
    // 90 — 54 points — mirroring the valuation side's 60-of-100 rule.
    var rk = riskScore(rec);
    if (!(rk && isNum(rk.score) && rk.maxAvailable >= 54)) return;
    // One score for the daily list (Justin's ask, 2026-10-27):
    // 60% how cheap it is + 40% how safe it is.
    var combined = Math.round(0.6 * s.score + 0.4 * (100 - rk.score));
    out.push({ t: t, name: rec.name, score: combined, price: isNum(rec.price) ? rec.price : null });
  });
  out.sort(function (a, b) { return b.score - a.score; });
  return out.slice(0, 10);
}

async function scanFetchPage(ixKey, v, r) {
  // Hard 30s race on top of fetchWithTimeout's abort: a throttled
  // Finviz can leave a request hanging, and a hung slot must free up
  // so the pump keeps moving instead of wedging at full concurrency.
  var work = (async function () {
    var resp = await fetchWithTimeout(SCAN_URL + '?v=' + v + '&f=' + ixKey + '&r=' + r, 25000);
    if (!resp.ok) { var e = new Error('screen ' + resp.status); e.status = resp.status; throw e; }
    var data = await resp.json();
    if (!data || !Array.isArray(data.rows)) throw new Error('screen payload');
    return data;
  })();
  var limit = new Promise(function (resolve, reject) {
    setTimeout(function () { var e = new Error('screen timeout'); e.timeout = true; reject(e); }, 30000);
  });
  return Promise.race([work, limit]);
}

/* Fallback route for scan pages (2026-10-28): every /screen page
 * leaves through the relay Worker's single Cloudflare egress IP, and
 * when Finviz flags that IP the whole scan stalls in cooldown cycles
 * -- 'won't stop throttling'. This route pulls the same screener page
 * through the public relays (different egress IPs) and extracts the
 * rows here, with the worker's own extraction mirrored field-for-field. */
var SCAN_VIEW_FIELDS = {
  '121': ['marketCap', 'PE', 'forwardPE', 'PEG', 'epsYoY1', 'price', 'change'],
  '161': ['grossMargin', 'netMargin', 'debtEq', 'curRatio'],
  '171': ['high52w', 'beta']
};
function scanExtractRows(html, v) {
  var anchor = '"data":{"rows":[';
  var i = html.indexOf(anchor);
  if (i < 0) return null;
  var start = i + anchor.length - 1;
  var j = html.indexOf('],"totalCount"', start);
  if (j < 0) return null;
  var rows = null, total = null;
  try { rows = JSON.parse(html.slice(start, j + 1)); } catch (e) {}
  if (!Array.isArray(rows)) return null;
  var tm = html.slice(j, j + 80).match(/"totalCount":(\d+)/);
  if (tm) total = parseInt(tm[1], 10);
  var keep = SCAN_VIEW_FIELDS[v] || [];
  var slim = rows.map(function (row) {
    var n = {};
    if (row.numbers) keep.forEach(function (k) { if (typeof row.numbers[k] === 'number') n[k] = row.numbers[k]; });
    return { t: row.text ? row.text.ticker : '', name: row.text ? row.text.company : '', n: n };
  }).filter(function (row) { return row.t; });
  return { total: total, rows: slim };
}

async function scanFetchPageAlt(ixKey, v, r) {
  var filter = ixKey === 'spx' ? 'idx_sp500' : 'idx_rut';
  var url = 'https://finviz.com/screener?v=' + v + '&f=' + filter + (r > 1 ? '&r=' + r : '');
  var work = (async function () {
    var html = await relayFetch(url, {
      timeout: 25000,
      validate: function (t) { return t.indexOf('"data":{"rows"') !== -1; }
    });
    var data = scanExtractRows(html, v);
    if (!data) { var e = new Error('screen payload'); e.status = 502; throw e; }
    return data;
  })();
  var limit = new Promise(function (resolve, reject) {
    setTimeout(function () { var e = new Error('screen timeout'); e.timeout = true; reject(e); }, 30000);
  });
  return Promise.race([work, limit]);
}

function scanSchedule(delay) {
  if (scanTimer) return;
  scanTimer = setTimeout(function () { scanTimer = null; scanStep(); scanStep(); }, delay);
}

function scanStep() {
  if (!scanRunning) return;
  var st = getScan();
  if (!st || st.done) { scanRunning = false; return; }
  var wait = scanCoolUntil - Date.now();
  if (wait > 0) { scanSchedule(wait); return; }
  if (scanActive >= 2) return;
  var job = null, jobIx = null;
  for (var i = 0; i < SCAN_IDXS.length && !job; i++) {
    var cand = st.idx[SCAN_IDXS[i].key];
    if (cand.started === false) continue;
    if (cand.pending.length) { job = cand.pending[0]; jobIx = SCAN_IDXS[i].key; }
  }
  if (!job) {
    if (scanActive === 0) {
      // Queue drained: complete only if nothing was dropped (among
      // the indexes that were started -- an unstarted Russell must
      // not hold the S&P's completion hostage).
      var droppedTotal = SCAN_IDXS.reduce(function (a, ix) { return a + (st.idx[ix.key].started === false ? 0 : st.idx[ix.key].dropped.length); }, 0);
      var results = {};
      SCAN_IDXS.forEach(function (ix) {
        var z = st.idx[ix.key];
        z.scored = Object.keys(z.merged).length;
        results[ix.key] = scanFinalizeIdx(z);
      });
      st.results = results;
      // Feed the persistent dataset: any index that landed complete
      // becomes the stored copy future days refresh incrementally.
      SCAN_IDXS.forEach(function (ix) {
        var z = st.idx[ix.key];
        if (z.started === false) return;
        if (z.pending.length || z.dropped.length) return;
        if (Object.keys(z.merged).length > 100) scanPersistIdx(ix.key, z.merged);
      });
      if (droppedTotal === 0) {
        st.done = true;
        st.partial = false;
        SCAN_IDXS.forEach(function (ix) { st.idx[ix.key].merged = {}; });
      } else {
        st.partial = true;
      }
      setScan(st);
      scanRunning = false;
      renderScanCard();
    }
    return;
  }
  var idxs = st.idx[jobIx];
  idxs.pending.shift();
  setScan(st);
  scanActive++;
  scanFetchPage(jobIx, job[0], job[1]).catch(function (err) {
    if (err && err.status === 502) return scanFetchPageAlt(jobIx, job[0], job[1]);
    throw err;
  }).then(function (data) {
    var st2 = getScan(); if (!st2) return;
    var ix2 = st2.idx[jobIx];
    if (isNum(data.total)) ix2.total = data.total;
    scanMerge(ix2, job[0], data.rows);
    ix2.pages++;
    if (job[1] === 1 && isNum(data.total)) {
      for (var r = 21; r <= data.total; r += 20) {
        var k = job[0] + ':' + r;
        if (!ix2.queued[k]) { ix2.queued[k] = 1; ix2.pending.push([job[0], r, 0]); }
      }
    }
    setScan(st2);
  }).catch(function (err) {
    // A 502 from the relay means Finviz blocked it (403): cool the
    // whole scan down instead of burning the page's retries at once.
    if (err && err.status === 502) scanCoolUntil = Date.now() + 25000;
    else if (err && err.timeout) scanCoolUntil = Date.now() + 10000;
    var st2 = getScan(); if (!st2) return;
    var ix2 = st2.idx[jobIx];
    if (job[2] < 4) { job[2]++; ix2.pending.push(job); }
    else ix2.dropped.push([job[0], job[1]]);
    setScan(st2);
  }).then(function () {
    scanActive--;
    renderScanCard();
    scanSchedule(350);
  });
}

function scanPump() {
  if (scanRunning) return;
  var s = getScan();
  if (!s || s.done || s.partial || s.date !== scanTodayKey()) return;
  scanRunning = true;
  scanStep(); scanStep();
}

function scanResume() {
  var s = getScan();
  if (!s) return;
  SCAN_IDXS.forEach(function (ix) {
    var z = s.idx[ix.key];
    if (z.started === false) return;
    z.dropped.forEach(function (dr) { z.pending.push([dr[0], dr[1], 0]); });
    z.dropped = [];
  });
  s.partial = false;
  setScan(s);
  renderScanCard();
  scanPump();
}

/* ---------- persistent scan dataset + earnings refresh ----------
 * Justin's ask (2026-10-28): don't rescan all ~2,460 companies every
 * day. A completed full scan stores every company's record; on later
 * days only the companies that reported earnings since then get
 * re-fetched (one Finviz quote page each -- earnings are when the
 * numbers actually change), and the lists re-rank from the stored
 * data. A full rescan still runs weekly (prices drift, companies
 * come and go) or whenever he taps Rescan. */
var SCAN_DATA_KEY = 'sr_scan_data_v1';
function getScanData() {
  try { var s = JSON.parse(localStorage.getItem(SCAN_DATA_KEY) || 'null'); return (s && s.recs) ? s : null; }
  catch (e) { return null; }
}
function setScanData(s) { try { localStorage.setItem(SCAN_DATA_KEY, JSON.stringify(s)); } catch (e) {} }

function scanPersistIdx(ixKey, merged) {
  var ds = getScanData() || { recs: {}, asOf: null, lastRefreshDay: null, lastRefreshCount: 0 };
  Object.keys(merged).forEach(function (t) {
    var r = merged[t];
    ds.recs[t] = { name: r.name, ix: ixKey, forwardPE: r.forwardPE, peg: r.peg, epsGrowthNextY: r.epsGrowthNextY,
      price: r.price, marketCap: r.marketCap, grossMargin: r.grossMargin, profitMargin: r.profitMargin,
      debtEq: r.debtEq, currentRatio: r.currentRatio, pctBelowHigh: r.pctBelowHigh, beta: r.beta };
  });
  if (ixKey === 'spx') ds.asOf = scanTodayKey();
  setScanData(ds);
}

/* One Finviz quote page -> a scan-shaped record (same fields the
 * screener merge produces). Missing fields keep the stored values. */
function scanRecordFromQuote(html, prev) {
  var d = { ticker: '', sources: [], errors: [] };
  try { fillFromFinviz(d, html); } catch (e) { return null; }
  var rec = { name: d.companyName || (prev && prev.name) || '', ix: prev && prev.ix };
  ['forwardPE', 'peg', 'price', 'marketCap', 'grossMargin', 'profitMargin', 'debtEq', 'beta', 'currentRatio', 'pctBelowHigh'].forEach(function (k) {
    rec[k] = isNum(d[k]) ? d[k] : (prev ? prev[k] : null);
  });
  if (isNum(d.epsNextY) && isNum(d.epsThisY) && d.epsThisY > 0) rec.epsGrowthNextY = (d.epsNextY / d.epsThisY - 1) * 100;
  else rec.epsGrowthNextY = prev ? prev.epsGrowthNextY : null;
  return rec;
}

function scanRankFromData(ds) {
  var byIx = { spx: { merged: {} }, rut: { merged: {} } };
  Object.keys(ds.recs).forEach(function (t) {
    var r = ds.recs[t];
    if (byIx[r.ix]) byIx[r.ix].merged[t] = r;
  });
  return { spx: scanFinalizeIdx(byIx.spx), rut: scanFinalizeIdx(byIx.rut) };
}

function scanShowDataResults(ds, refreshed) {
  var today = scanTodayKey();
  var s = getScan();
  if (!s || s.date !== today) s = scanFreshState();
  s.results = scanRankFromData(ds);
  s.done = true;
  s.partial = false;
  s.fromData = true;
  s.dataAsOf = ds.asOf;
  s.refreshed = refreshed;
  SCAN_IDXS.forEach(function (ix) {
    var n = Object.keys(ds.recs).filter(function (t) { return ds.recs[t].ix === ix.key; }).length;
    s.idx[ix.key].scored = n;
    // Stored rows for this index mean its list renders; leaving the
    // fresh-day started=false in place would swap in the on-demand
    // "Scan Russell" button instead of the stored Russell list.
    if (n > 0) s.idx[ix.key].started = true;
  });
  setScan(s);
  renderScanCard();
}

var scanRefreshing = false;
async function scanRefreshReporters() {
  var ds = getScanData();
  if (!ds || scanRefreshing) return;
  var today = scanTodayKey();
  if (ds.lastRefreshDay === today) { scanShowDataResults(ds, ds.lastRefreshCount || 0); return; }
  scanRefreshing = true;
  scanShowDataResults(ds, null); // stored lists instantly; counts update when the refresh lands
  try {
    // Earnings calendar for the days since the last refresh (plus a
    // one-day overlap: evening reporters update Finviz overnight),
    // capped at 10 days back.
    var startMs = Date.parse((ds.lastRefreshDay || ds.asOf) + 'T12:00:00') - 86400000;
    var todayMs = Date.parse(today + 'T12:00:00');
    var reporters = {};
    for (var ms = startMs; ms <= todayMs; ms += 86400000) {
      if ((todayMs - ms) / 86400000 > 10) continue;
      var iso = pfKeyToISO(pfDkey(new Date(ms)));
      try {
        var cal = await relayJSON('https://api.nasdaq.com/api/calendar/earnings?date=' + iso);
        var rows = (cal && cal.data && cal.data.rows) || [];
        rows.forEach(function (r) { if (r.symbol && ds.recs[r.symbol]) reporters[r.symbol] = 1; });
      } catch (e) {}
    }
    var list = Object.keys(reporters);
    var updated = 0;
    for (var i = 0; i < list.length; i += 2) {
      var batch = list.slice(i, i + 2);
      await Promise.all(batch.map(async function (t) {
        try {
          var html = await relayFetch('https://finviz.com/quote.ashx?t=' + encodeURIComponent(t), { timeout: 20000 });
          var rec = scanRecordFromQuote(html, ds.recs[t]);
          if (rec) { ds.recs[t] = rec; updated++; }
        } catch (e) {}
      }));
      if (i + 2 < list.length) await new Promise(function (r) { setTimeout(r, 300); });
    }
    ds.lastRefreshDay = today;
    ds.lastRefreshCount = updated;
    setScanData(ds);
    scanShowDataResults(ds, updated);
  } catch (e) {
    scanShowDataResults(ds, 0);
  }
  scanRefreshing = false;
}

function maybeStartScan() {
  var s = getScan();
  var today = scanTodayKey();
  if (s && s.date === today) {
    renderScanCard();
    if (!s.done && !s.partial && !s.fromData) scanPump();
    return;
  }
  var ds = getScanData();
  if (ds && ds.asOf) {
    var ageDays = (Date.parse(today + 'T12:00:00') - Date.parse(ds.asOf + 'T12:00:00')) / 86400000;
    if (ageDays < 7) { scanRefreshReporters(); return; }
  }
  s = scanFreshState();
  setScan(s);
  renderScanCard();
  scanPump();
}

function scanScoreClass(score) { return score >= 70 ? 'up' : (score >= 45 ? '' : 'down'); }

/* Tappable share-amount sheet for purchases/sales (Justin's ask,
 * 2026-10-26): typing ALL into a phone prompt was too easy to miss,
 * so the amount step is now an in-app sheet with a real All button.
 * Resolves with a number (All -> cap), NaN for an empty/invalid
 * entry (callers show their usual alert), or null on cancel. */
function pfShareSheet(title, cap, initial) {
  return new Promise(function (resolve) {
    var bg = document.createElement('div');
    bg.className = 'pf-sheet-bg';
    var allBtn = (isNum(cap) && cap > 0)
      ? '<button type="button" class="btn-ghost" id="pf-sh-all">All \u00b7 ' + fmtShares(cap) + '</button>' : '';
    bg.innerHTML = '<div class="pf-sheet"><h4>' + esc(title) + '</h4>' +
      '<div class="pf-sheet-row"><input id="pf-sh-in" type="text" inputmode="decimal" autocomplete="off" placeholder="Shares" value="' + (isNum(initial) ? esc(String(initial)) : '') + '">' + allBtn + '</div>' +
      '<div class="pf-sheet-row" style="margin-top:10px"><button type="button" class="btn-ghost" id="pf-sh-cancel" style="flex:1">Cancel</button><button type="button" class="pf-sh-save" id="pf-sh-ok" style="flex:1">Save</button></div></div>';
    document.body.appendChild(bg);
    var done = false;
    function close(v) {
      if (done) return; done = true;
      if (bg.parentNode) bg.parentNode.removeChild(bg);
      resolve(v);
    }
    bg.querySelector('#pf-sh-cancel').addEventListener('click', function () { close(null); });
    bg.addEventListener('click', function (e) { if (e.target === bg) close(null); });
    var all = bg.querySelector('#pf-sh-all');
    if (all) all.addEventListener('click', function () { close(cap); });
    bg.querySelector('#pf-sh-ok').addEventListener('click', function () {
      close(parseFloat(bg.querySelector('#pf-sh-in').value));
    });
    var inp = bg.querySelector('#pf-sh-in');
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); bg.querySelector('#pf-sh-ok').click(); }
    });
    setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) {} }, 60);
  });
}

function renderScanCard() {
  var box = $('scan-card');
  if (!box) return;
  var s = getScan();
  if (!s || s.date !== scanTodayKey()) {
    box.innerHTML = '<div class="card scan-card"><div class="scan-h">Top value + low risk today</div><div class="status">Preparing today\'s scan\u2026</div></div>';
    return;
  }
  var html = '<div class="card scan-card"><div class="scan-h">Top value + low risk today <span class="scan-date">' + esc(s.date) + '</span></div>';
  var listsHtml = function () {
    var out = '';
    SCAN_IDXS.forEach(function (ix) {
      var rows = (s.results && s.results[ix.key]) || [];
      var z = s.idx[ix.key];
      if (z.started === false) {
        out += '<div class="scan-group">' + esc(ix.label) + '</div>' +
          '<div class="fineprint" style="margin:0 0 8px">297 of the 375 scan pages — on demand, so the daily S&amp;P scan stays fast.</div>' +
          '<button type="button" class="btn-ghost" id="scan-start-rut">Scan Russell 2000</button>';
        return;
      }
      var countTxt = isNum(z.scored) ? z.scored + ' stocks scored' : '';
      out += '<div class="scan-group">' + esc(ix.label) + (countTxt ? ' <span class="scan-count">' + countTxt + '</span>' : '') + '</div>';
      if (!rows.length) { out += '<div class="status">No scored stocks came back.</div>'; }
      rows.forEach(function (row, i) {
        out += '<button type="button" class="scan-row" data-scan-research="' + esc(row.t) + '">' +
          '<span class="scan-rank">' + (i + 1) + '</span>' +
          '<span class="scan-id"><b>' + esc(row.t) + '</b><span>' + esc(row.name) + '</span></span>' +
          '<span class="scan-px">' + (isNum(row.price) ? fmtMoney(row.price) : '\u2014') + '</span>' +
          '<span class="scan-score ' + scanScoreClass(row.score) + '">Score ' + row.score + '</span></button>';
      });
    });
    return out;
  };
  if (s.done && s.results) {
    html += listsHtml();
    html += '<div class="scan-foot">One combined score: 60% valuation + 40% safety (100 \u2212 risk: beta, debt, margins, size, EPS trend, current ratio).' +
      (s.fromData
        ? ' Stored data from ' + esc(s.dataAsOf || '') + (s.refreshed === null ? ' \u2014 refreshing today\u2019s earnings reporters\u2026' : ' \u00b7 ' + (s.refreshed || 0) + ' earnings reporters refreshed today') + ' \u00b7 full rescan weekly.'
        : ' Full scan from today.') +
      ' <button type="button" class="btn-mini" id="scan-rescan">Rescan</button></div>';
  } else if (s.partial && s.results) {
    var scoredSum = 0, totalSum = 0, droppedSum = 0;
    SCAN_IDXS.forEach(function (ix) {
      var z = s.idx[ix.key];
      if (z.started === false) return;
      scoredSum += z.scored || 0;
      totalSum += z.total || 0;
      droppedSum += z.dropped.length;
    });
    html += '<div class="status err">Partial scan \u2014 Finviz throttled the feed partway (' + scoredSum + ' of ' + totalSum + ' stocks in, ' + droppedSum + ' pages blocked). These lists are provisional.</div>' +
      '<button type="button" class="btn-ghost" id="scan-resume">Resume the scan</button>';
    html += listsHtml();
    html += '<div class="scan-foot"><button type="button" class="btn-mini" id="scan-rescan">Start over</button></div>';
  } else {
    var pages = 0, stocks = 0, pending = 0;
    SCAN_IDXS.forEach(function (ix) {
      var z = s.idx[ix.key];
      pages += z.pages; pending += z.pending.length + z.dropped.length;
      stocks += Object.keys(z.merged).length;
    });
    if (pages === 0 && pending === 0 && !scanRunning) {
      html += '<div class="status err">The scan couldn\'t reach the data source.</div><button type="button" class="btn-ghost" id="scan-retry">Retry the scan</button>';
    } else {
      var pct = (pages + pending) > 0 ? Math.round(pages / (pages + pending) * 100) : 0;
      var cooling = scanCoolUntil > Date.now();
      var rutOn = s.idx.rut && s.idx.rut.started !== false;
      html += '<div class="status"><span class="spinner"></span>' + (cooling ? 'Finviz is throttling \u2014 cooling down for a few seconds, then continuing\u2026 ' : (rutOn ? 'Scanning the S&P 500 and Russell 2000\u2026 ' : 'Scanning the S&P 500\u2026 ')) + pages + ' pages in, ' + stocks + ' stocks so far. It runs gently (a few minutes) to stay under Finviz\'s rate limit, and resumes if you close the app.</div>' +
        '<div class="scan-bar"><i style="width:' + pct + '%"></i></div>';
    }
  }
  html += '</div>';
  box.innerHTML = html;
  var rs = $('scan-rescan');
  if (rs) rs.addEventListener('click', function () { setScan(scanFreshState()); renderScanCard(); scanPump(); });
  var rt = $('scan-retry');
  if (rt) rt.addEventListener('click', function () { setScan(scanFreshState()); renderScanCard(); scanPump(); });
  var rm = $('scan-resume');
  if (rm) rm.addEventListener('click', function () { scanResume(); });
  var sr2 = $('scan-start-rut');
  if (sr2) sr2.addEventListener('click', function () { scanStartIndex('rut'); });
  box.querySelectorAll('[data-scan-research]').forEach(function (b) {
    b.addEventListener('click', function () {
      var T = b.getAttribute('data-scan-research');
      switchTab('scorecard');
      $('search-input').value = T;
      runSearch(T);
    });
  });
}

async function renderWatchlist(refresh) {
  var wl = getWatchlist();
  var box = $('wl-list');
  if (!wl.length) {
    box.innerHTML = '<div class="empty-note"><h2>Nothing here yet</h2><p>Add a ticker and the buy price you\'re waiting for. Prices refresh live; the list lives only on this device.</p></div>';
    return;
  }
  if (refresh) $('wl-status').innerHTML = '<span class="spinner"></span>Refreshing\u2026';
  // Gather prices first so the list can be sorted on real numbers.
  var rows = [];
  for (var i = 0; i < wl.length; i++) {
    var item = wl[i];
    var price = null, err = null;
    try { price = await fetchLightPrice(item.ticker); } catch (e) { err = e.message; }
    var projMap = getProjections();
    rows.push({ item: item, price: price, err: err, val: wlValuationDisplay(item.ticker), proj: !!projMap[item.ticker], projCagr: projMap[item.ticker] ? pjSavedCagr(item.ticker) : null });
  }
  // On an explicit refresh, fill in missing or stale valuation scores
  // with a Finviz-only pass (a fresh full scorecard score wins as-is).
  if (refresh) {
    var vmap = lsGet(WLVAL_KEY, {});
    var dirty = false;
    await Promise.all(rows.map(async function (r) {
      if (r.val && r.val.fresh && isNum(r.val.risk)) return;
      var v = await fetchWlValuation(r.item.ticker);
      if (v) {
        vmap[r.item.ticker] = { score: v.score, verdict: v.verdict, risk: v.risk, at: Date.now() };
        r.val = { score: v.score, verdict: v.verdict, risk: v.risk, fresh: true };
        dirty = true;
      }
    }));
    if (dirty) lsSet(WLVAL_KEY, vmap);
  }
  var mode = getWlSort();
  rows.sort(function (a, b) {
    if (mode === 'valuation') {
      var sa = a.val ? a.val.score : -1, sb = b.val ? b.val.score : -1;
      return sb - sa;
    }
    if (mode === 'valuation-asc') {
      var sa2 = a.val ? a.val.score : 1000, sb2 = b.val ? b.val.score : 1000;
      return sa2 - sb2;
    }
    if (mode === 'target') {
      var da = (isNum(a.price) && isNum(a.item.target) && a.item.target > 0) ? (a.price / a.item.target - 1) : Infinity;
      var db = (isNum(b.price) && isNum(b.item.target) && b.item.target > 0) ? (b.price / b.item.target - 1) : Infinity;
      return da - db;
    }
    if (mode === 'ticker') return a.item.ticker.localeCompare(b.item.ticker);
    return (a.item.addedAt || 0) - (b.item.addedAt || 0);
  });
  var html = '';
  rows.forEach(function (r) {
    var item = r.item, price = r.price;
    var distHtml = '<span class="pill far">no target set</span>';
    if (isNum(price) && isNum(item.target) && item.target > 0) {
      var above = (price / item.target - 1) * 100;
      if (price <= item.target) distHtml = '<span class="pill hit">\u2713 AT / BELOW TARGET</span>';
      else if (above <= 10) distHtml = '<span class="pill near">' + fmtNum(above, 1) + '% above target</span>';
      else distHtml = '<span class="pill far">' + fmtNum(above, 1) + '% above target</span>';
    }
    html += '<div class="wl-row"><div class="wl-left"><span class="wl-t">' + esc(item.ticker) + '</span>' +
      '<div class="wl-meta">Target buy: ' + (isNum(item.target) ? fmtMoney(item.target) : '\u2014') + '</div>' +
      (r.val ? '<div class="wl-meta wl-val">Valuation <b style="color:hsl(' + Math.round(r.val.score * 1.2) + ', 78%, var(--val-l))">' + r.val.score + '</b>' + (isNum(r.val.risk) ? ' \u00b7 Risk <b style="color:hsl(' + Math.round((100 - r.val.risk) * 1.2) + ', 78%, var(--val-l))">' + r.val.risk + '</b>' : '') + '</div>' : '') +
      '</div>' +
      '<div class="wl-right"><div class="wl-price">' + (isNum(price) ? fmtMoney(price) : '\u2014') + '</div>' +
      '<div style="text-align:right">' + (r.err ? '<span class="factor-note">price unavailable</span>' : distHtml) + '</div>' +
      '<div class="wl-actions">' + '<button class="link-btn" data-wl-proj="' + esc(item.ticker) + '">Projection' + (r.proj && isNum(r.projCagr) ? ' \u00b7 Base ' + fmtPct(r.projCagr) + '/yr' : '') + '</button>' +
      '<button class="link-btn wl-more-btn" data-wl-more="' + esc(item.ticker) + '" aria-label="More actions">\u00b7\u00b7\u00b7</button>' +
      '<span class="wl-sub"><button class="link-btn" data-research="' + esc(item.ticker) + '">Research</button>' +
      '<button class="link-btn" data-wl-edit="' + esc(item.ticker) + '">Edit target</button>' +
      '<a class="link-btn" href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&ticker=' + encodeURIComponent(item.ticker) + '&type=10-Q&dateb=&owner=include&count=10" target="_blank" rel="noopener">Earnings report</a>' +
      '<a class="link-btn" href="https://www.youtube.com/results?search_query=' + encodeURIComponent(item.ticker + ' earnings call') + '" target="_blank" rel="noopener">Earnings call</a>' +
      '<button class="link-btn danger" data-wl-del="' + esc(item.ticker) + '">Remove</button></span></div></div></div>';
  });
  $('wl-status').textContent = '';
  box.innerHTML = html;
  box.querySelectorAll('[data-research]').forEach(function (b) {
    b.addEventListener('click', function () { switchTab('scorecard'); $('search-input').value = b.getAttribute('data-research'); runSearch(b.getAttribute('data-research')); });
  });
  box.querySelectorAll('[data-wl-proj]').forEach(function (b) {
    b.addEventListener('click', function () {
      var T = b.getAttribute('data-wl-proj');
      switchTab('tools');
      if (getProjections()[T]) {
        pjRestore(T);
        var el = $('pj-result');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
      } else {
        $('pj-ticker').value = T;
        loadProjectionTicker();
      }
    });
  });
  box.querySelectorAll('[data-wl-more]').forEach(function (b) {
    b.addEventListener('click', function () {
      var sub = b.parentElement ? b.parentElement.querySelector('.wl-sub') : null;
      if (sub) sub.classList.toggle('open');
    });
  });
  box.querySelectorAll('[data-wl-del]').forEach(function (b) {
    b.addEventListener('click', function () {
      setWatchlist(getWatchlist().filter(function (x) { return x.ticker !== b.getAttribute('data-wl-del'); }));
      renderWatchlist(false);
    });
  });
  box.querySelectorAll('[data-wl-edit]').forEach(function (b) {
    b.addEventListener('click', function () {
      var T = b.getAttribute('data-wl-edit');
      var cur = getWatchlist().filter(function (x) { return x.ticker === T; })[0];
      var v = window.prompt('Target buy price for ' + T + ' ($):', cur && isNum(cur.target) ? cur.target : '');
      if (v === null) return;
      var n = parseFloat(v);
      var wl2 = getWatchlist();
      wl2.forEach(function (x) { if (x.ticker === T) x.target = isNum(n) ? n : null; });
      setWatchlist(wl2);
      renderWatchlist(false);
    });
  });
}


/* ============================== portfolio ============================== */
/* Manual holdings tracker. The app asks how many shares are owned and
 * whether dividends are reinvested (DRIP); average cost is optional and
 * powers the gain/loss figures. Prices and dividend yields come from the
 * same light Finviz pass the watchlist valuation uses, and the last
 * known quotes are cached so the tab paints instantly. */
var PF_KEY = 'sr_portfolio_v1';
var PF_PX_KEY = 'sr_pfpx_v1';
var pfFetchedOnce = false;
function getPortfolio() { return lsGet(PF_KEY, []); }
function setPortfolio(p) { lsSet(PF_KEY, p); }
function pfQuotes() { return lsGet(PF_PX_KEY, {}); }
function fmtShares(v) { return isNum(v) ? String(parseFloat(v.toFixed(4))) : '—'; }

async function fetchPfQuote(T) {
  var html = await relayFetch('https://finviz.com/quote.ashx?t=' + encodeURIComponent(T));
  var d = { ticker: T, sources: [], errors: [] };
  fillFromFinviz(d, html);
  if (!isNum(d.price)) throw new Error('no price');
  var chg = d.sourceFinviz ? parseNum(d.sourceFinviz['Change %']) : null;
  return { price: d.price, divYield: isNum(d.divYield) ? d.divYield : null,
           dayChg: isNum(chg) ? chg : null, name: d.companyName || null, ts: Date.now() };
}

var pfOpen = {};
/* The user's Coolors palette (deep navy -> pale sky). When there are
 * more slices than palette colors, new colors are interpolated between
 * neighbouring palette stops so the gradient just gets finer. */
var PF_PALETTE = ['#012A4A', '#013A63', '#01497C', '#014F86', '#2A6F97', '#2C7DA0', '#468FAF', '#61A5C2', '#89C2D9', '#A9D6E5', '#95D5B2', '#F4E285', '#FFD6A5', '#FBC4D6'];
function pfPaletteColors(n) {
  // Always spread the picks across the whole palette (not just its
  // first stops), so the lighter, varied tones show even with only a
  // handful of holdings; extra colors are blended between stops.
  if (n <= 1) return PF_PALETTE.slice(0, Math.max(n, 0));
  function hx(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
  var stops = PF_PALETTE.map(hx), out = [];
  for (var i = 0; i < n; i++) {
    var t = i / (n - 1) * (stops.length - 1);
    var k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
    var rgb = stops[k].map(function (v, j) { return Math.round(v + (stops[k + 1][j] - v) * f); });
    out.push('#' + rgb.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('').toUpperCase());
  }
  return out;
}
/* Readable initial-letter color on a palette disc: white on the dark
 * blues, near-black on the pale ones. */
function pfInk(hex) {
  var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.45 ? '#141414' : '#FFFFFF';
}
/* Estimated purchase date for a holding: the most recent day in the
 * cached daily history whose close sat within 3% of the average cost
 * the user entered. Returns a YYYYMMDD key, or null when the price
 * never came near the cost in the available history. */
function pfEstBuyKey(pts, cost) {
  if (!pts || !isNum(cost) || cost <= 0) return null;
  for (var i = pts.length - 1; i >= 0; i--) {
    if (Math.abs(pts[i][1] - cost) / cost <= 0.03) return pts[i][0];
  }
  return null;
}
function pfEstKeyFor(p, hh) {
  if (p.estOverride) { var dk = pfDkey(new Date(p.estOverride + 'T12:00:00')); if (isNum(dk) && dk > 0) return dk; }
  return (hh && isNum(p.cost)) ? pfEstBuyKey(hh.pts, p.cost) : null;
}
function pfSoldShares(p) { return (p.sells || []).reduce(function (a, s) { return a + s.sh; }, 0); }

/* Fully sold = the sales log covers everything the position ever
 * accounted for: the logged purchases when they exist, otherwise the
 * share count itself. (Before this, a position counted as closed
 * only if the user ALSO zeroed the share count by hand -- so selling
 * all 22 shares of NOW left it sitting in the open list, still
 * adding its value to the totals.) */
function pfIsClosed(pos) {
  var sold = pfSoldShares(pos);
  if (!(sold > 0)) return false;
  var bought = (pos.buys || []).reduce(function (a, b) { return a + (b.sh || 0); }, 0);
  var total = bought > 0 ? bought : (pos.shares || 0);
  return sold >= total - 1e-9;
}
function pfPriceAt(pts, key) {
  if (!pts || !pts.length) return null;
  var last = null;
  for (var i = 0; i < pts.length && pts[i][0] <= key; i++) last = pts[i][1];
  return last != null ? last : pts[0][1];
}
/* Realized result of a position's logged sales: proceeds from the
 * recorded sale prices (or that day's close), basis from the average
 * cost if given, else the weighted price of the logged buys. */
function pfRealized(p, hh) {
  if (!p.sells || !p.sells.length) return null;
  var soldSh = 0, proceeds = 0;
  p.sells.forEach(function (s) {
    var px = isNum(s.px) ? s.px : (hh ? pfPriceAt(hh.pts, pfDkey(new Date(s.d + 'T12:00:00'))) : null);
    if (isNum(px)) { proceeds += s.sh * px; soldSh += s.sh; }
  });
  if (!soldSh) return null;
  var basisPer = null;
  if (isNum(p.cost)) basisPer = p.cost;
  else if (p.buys && p.buys.length && hh) {
    var tb = 0, ts = 0;
    p.buys.forEach(function (b) { var bp = pfPriceAt(hh.pts, pfDkey(new Date(b.d + 'T12:00:00'))); if (isNum(bp)) { tb += b.sh * bp; ts += b.sh; } });
    if (ts > 0) basisPer = tb / ts;
  }
  var gain = isNum(basisPer) ? proceeds - basisPer * soldSh : null;
  return { proceeds: proceeds, gain: gain, pct: (isNum(gain) && basisPer > 0) ? gain / (basisPer * soldSh) * 100 : null, sh: soldSh };
}
function pfFmtDate(key) {
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return MON[(Math.floor(key / 100) % 100) - 1] + ' ' + (key % 100) + ', ' + Math.floor(key / 10000);
}
function pfKeyToISO(key) {
  return Math.floor(key / 10000) + '-' + String(Math.floor(key / 100) % 100).padStart(2, '0') + '-' + String(key % 100).padStart(2, '0');
}
function pfLogoErr(img) {
  var fb = img.getAttribute('data-fb');
  if (fb) { img.removeAttribute('data-fb'); img.src = fb; }
  else img.style.display = 'none';
}
function pfLogoImg(ticker) {
  return '<img class="pf-logo" src="https://financialmodelingprep.com/image-stock/' + encodeURIComponent(ticker) + '.png" data-fb="https://assets.parqet.com/logos/symbol/' + encodeURIComponent(ticker) + '?format=png" onerror="pfLogoErr(this)" alt="">';
}
function pfKv(k, v) { return '<div class="pf-kv"><span>' + k + '</span><b>' + v + '</b></div>'; }

/* ============================== portfolio news ==============================
 * A News view inside the Portfolio tab: the latest headlines for the
 * stocks he actually holds, from Yahoo Finance's per-ticker RSS feeds
 * (through the relay), newest first, each tappable through to the
 * article. Cached on-device for 3 hours; a changed holdings list
 * counts as stale. Parsing is regex-based, same as the relay's own
 * headline reader. */
var PF_NEWS_TTL = 3 * 3600 * 1000;
var pfNewsLoading = false;

function pfNewsDecode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(parseInt(n, 10)); })
    .trim();
}

function parseYahooRss(xml, T) {
  var out = [];
  var itemRe = /<item>([\s\S]*?)<\/item>/g, m;
  while ((m = itemRe.exec(String(xml || ''))) !== null) {
    var body = m[1];
    var title = body.match(/<title>([\s\S]*?)<\/title>/);
    var link = body.match(/<link>([\s\S]*?)<\/link>/);
    var date = body.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    var source = body.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    if (!title || !link) continue;
    var ts = date ? Date.parse(pfNewsDecode(date[1])) : NaN;
    out.push({
      t: T,
      title: pfNewsDecode(title[1]),
      link: pfNewsDecode(link[1]),
      source: source ? pfNewsDecode(source[1]) : '',
      ts: isNum(ts) ? ts : 0
    });
  }
  return out;
}

function pfNewsAgo(ts) {
  if (!ts) return '';
  var mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return mins + 'm ago';
  var hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  var days = Math.round(hrs / 24);
  return days + (days === 1 ? ' day ago' : ' days ago');
}

function getPfNews() {
  try { return JSON.parse(localStorage.getItem('sr_pfnews_v1') || 'null'); } catch (e) { return null; }
}
function setPfNews(c) { try { localStorage.setItem('sr_pfnews_v1', JSON.stringify(c)); } catch (e) {} }
function pfNewsTickers() {
  return getPortfolio().filter(function (p) { return p.shares > 0 && !pfIsClosed(p); }).map(function (p) { return p.ticker; });
}
function pfNewsStale() {
  var c = getPfNews();
  if (!c) return true;
  if (c.tickersKey !== pfNewsTickers().join(',')) return true;
  return (Date.now() - (c.fetchedAt || 0)) > PF_NEWS_TTL;
}

function renderPfNews() {
  var box = $('pf-news');
  if (!box) return;
  var tickers = pfNewsTickers();
  var head = '<div class="row-between"><span class="scan-h">News for your holdings</span>' +
    '<button type="button" class="btn-mini" id="pf-news-refresh">Refresh</button></div>';
  if (!tickers.length) {
    box.innerHTML = head + '<div class="empty-note"><p>Add a holding and its latest headlines will show up here.</p></div>';
  } else {
    var c = getPfNews();
    if (pfNewsLoading) {
      box.innerHTML = head + '<div class="status"><span class="spinner"></span>Fetching headlines for ' + tickers.length + ' holdings\u2026</div>';
    } else if (!c || !c.items) {
      box.innerHTML = head + '<div class="status">Tap Refresh to fetch today\'s headlines.</div>';
    } else if (!c.items.length) {
      box.innerHTML = head + '<div class="status">No headlines came back \u2014 try Refresh.</div>';
    } else {
      var updated = c.fetchedAt ? 'Updated ' + pfNewsAgo(c.fetchedAt) : '';
      var newsCols = pfPaletteColors(Math.max(1, tickers.length));
      var rowsHtml = c.items.map(function (it) {
        var meta = [it.source, pfNewsAgo(it.ts)].filter(Boolean).join(' \u00b7 ');
        var col = newsCols[Math.max(0, tickers.indexOf(it.t)) % newsCols.length];
        return '<a class="news-row" href="' + esc(it.link) + '" target="_blank" rel="noopener">' +
          '<span class="pf-avatar news-ava" style="background:' + col + ';color:' + pfInk(col) + '">' + esc(it.t.charAt(0)) + pfLogoImg(it.t) + '</span>' +
          '<span class="news-main"><b>' + esc(it.title) + '</b><span>' + esc(it.t) + (meta ? ' \u00b7 ' + esc(meta) : '') + '</span></span></a>';
      }).join('');
      box.innerHTML = head + (updated ? '<div class="status">' + updated + ' \u00b7 Yahoo Finance</div>' : '') + '<div class="card news-card">' + rowsHtml + '</div>';
    }
  }
  var rb = $('pf-news-refresh');
  if (rb) rb.addEventListener('click', function () { refreshPfNews(true); });
}

async function refreshPfNews(force) {
  if (pfNewsLoading) return;
  if (!force && !pfNewsStale()) { renderPfNews(); return; }
  var tickers = pfNewsTickers();
  if (!tickers.length) { renderPfNews(); return; }
  pfNewsLoading = true;
  renderPfNews();
  var per = await Promise.all(tickers.map(async function (T) {
    try {
      var xml = await relayFetch('https://feeds.finance.yahoo.com/rss/2.0/headline?s=' + encodeURIComponent(T) + '&region=US&lang=en-US');
      return parseYahooRss(xml, T).slice(0, 4);
    } catch (e) { return []; }
  }));
  var seen = {}, items = [];
  per.forEach(function (arr) {
    arr.forEach(function (it) {
      if (it.link && !seen[it.link]) { seen[it.link] = 1; items.push(it); }
    });
  });
  items.sort(function (a, b) { return b.ts - a.ts; });
  setPfNews({ fetchedAt: Date.now(), tickersKey: tickers.join(','), items: items.slice(0, 60) });
  pfNewsLoading = false;
  renderPfNews();
}

function pfView() { return localStorage.getItem('sr_pfview_v1') === 'news' ? 'news' : 'overview'; }
function pfSetView(v) {
  try { localStorage.setItem('sr_pfview_v1', v); } catch (e) {}
  var sec = $('tab-portfolio');
  if (sec) sec.classList.toggle('news-mode', v === 'news');
  var bo = $('pf-view-overview'), bn = $('pf-view-news'), news = $('pf-news');
  if (bo) bo.classList.toggle('on', v !== 'news');
  if (bn) bn.classList.toggle('on', v === 'news');
  if (news) news.hidden = v !== 'news';
  if (v === 'news') { renderPfNews(); refreshPfNews(false); }
}

async function renderPortfolio(doFetch) {
  var listBox = $('pf-list'), sumBox = $('pf-summary'), status = $('pf-status');
  if (!listBox || !sumBox) return;
  var positions = getPortfolio();
  if (!positions.length) {
    sumBox.innerHTML = '';
    var bb0 = $('pf-bench'); if (bb0) bb0.innerHTML = '';
    var cb0 = $('pf-closed'); if (cb0) cb0.innerHTML = '';
    listBox.innerHTML = '<div class="card"><h3 style="margin-top:0">Nothing here yet</h3><p class="fineprint" style="margin:0">Add a stock you own above \u2014 the app asks how many shares you have and whether its dividends are reinvested \u2014 and it will track the value and dividend income here.</p></div>';
    if (status) status.textContent = '';
    return;
  }
  if (doFetch) {
    if (status) status.innerHTML = '<span class="spinner"></span>Fetching live prices\u2026';
    var quotes = pfQuotes();
    await Promise.all(positions.map(async function (p) {
      if (!(p.shares > 0)) return;
      try { quotes[p.ticker] = await fetchPfQuote(p.ticker); } catch (e) {}
    }));
    lsSet(PF_PX_KEY, quotes);
    pfFetchedOnce = true;
    if (status) status.textContent = '';
  }
  var q = pfQuotes();
  // First pass: derive everything per holding and total it up.
  var totVal = 0, totInc = 0, totCost = 0, anyCost = false, dayNum = 0, dayDen = 0;
  var rows = positions.map(function (p) {
    var closed = pfIsClosed(p);
    var qt = q[p.ticker] || {};
    var px = isNum(qt.price) ? qt.price : null;
    var val = isNum(px) ? px * p.shares : null;
    var inc = (isNum(val) && isNum(qt.divYield)) ? val * qt.divYield / 100 : null;
    var costTot = isNum(p.cost) ? p.cost * p.shares : null;
    var gain = (isNum(val) && isNum(costTot)) ? val - costTot : null;
    var gainPct = (isNum(gain) && costTot > 0) ? gain / costTot * 100 : null;
    if (!closed) {
      if (isNum(val)) totVal += val;
      if (isNum(inc)) totInc += inc;
      if (isNum(costTot)) { totCost += costTot; anyCost = true; }
      if (isNum(val) && isNum(qt.dayChg)) { dayNum += val * qt.dayChg; dayDen += val; }
    }
    return { p: p, qt: qt, px: px, val: val, inc: inc, gain: gain, gainPct: gainPct, closed: closed };
  });
  var anyPx = totVal > 0;
  var dayPct = dayDen > 0 ? dayNum / dayDen : null;
  // Colors follow value rank so the chart, its labels and the rows agree.
  var ranked = rows.filter(function (r) { return !r.closed && isNum(r.val) && r.val > 0; }).slice().sort(function (a, b) { return b.val - a.val; });
  var sliceColors = pfPaletteColors(ranked.length);
  var colorOf = {};
  ranked.forEach(function (r, i) { colorOf[r.p.ticker] = sliceColors[i]; });
  // Holdings list: biggest first, like the reference.
  var ordered = rows.slice().sort(function (a, b) { return (b.val || 0) - (a.val || 0); });
  var html = '', htmlClosed = '';
  ordered.forEach(function (r) {
    var p = r.p, qt = r.qt;
    var isClosed = r.closed;
    var rzH = isClosed ? pfRealized(p, pfHistAll()[p.ticker]) : null;
    var frac = (isNum(r.val) && totVal > 0) ? r.val / totVal * 100 : null;
    var open = !!pfOpen[p.ticker];
    var col = colorOf[p.ticker] || '#5A5A5E';
    var rowH = '<div class="wl-row pf-row' + (open ? ' open' : '') + '">' +
      '<button class="pf-head" data-pf-toggle="' + esc(p.ticker) + '" aria-expanded="' + open + '">' +
        '<span class="pf-avatar" style="background:' + col + ';color:' + pfInk(col) + '">' + esc(p.ticker.charAt(0)) + pfLogoImg(p.ticker) + '</span>' +
        '<span class="wl-left"><span class="wl-t">' + esc(p.ticker) + '</span>' +
        (qt.name ? '<span class="pf-name">' + esc(qt.name) + '</span>' : '') + '</span>' +
        '<span class="pf-alloc">' + (isClosed ? 'Closed' : isNum(frac) ? fmtNum(frac, 1) + '%' : '\u2014') + '</span>' +
        '<span class="wl-right"><span class="pf-valpill">' + (isClosed ? (rzH && isNum(rzH.gain) ? (rzH.gain >= 0 ? '+' : '') + fmtMoney(rzH.gain, 0) : 'Sold') : isNum(r.val) ? fmtMoney(r.val, 0) : '\u2014') + '</span>' +
        '<span class="wl-meta" style="text-align:right">' + (isClosed ? 'fully sold' : isNum(r.px) ? fmtMoney(r.px) + '/share' : 'price unavailable') + '</span></span>' +
        '<span class="pf-chev">\u25be</span>' +
      '</button>';
    if (open) {
      rowH += '<div class="pf-detail">' +
        pfKv('Shares', fmtShares(p.shares)) +
        (isNum(p.cost) ? pfKv('Average cost', fmtMoney(p.cost) + '/share') : '') +
        (isNum(qt.dayChg) ? pfKv('Today', '<span class="' + (qt.dayChg >= 0 ? 'up' : 'down') + '">' + fmtPct(qt.dayChg) + '</span>') : '') +
        (isNum(r.gain) ? pfKv('Gain/loss', '<span class="' + (r.gain >= 0 ? 'up' : 'down') + '">' + (r.gain >= 0 ? '+' : '') + fmtMoney(r.gain, 0) + (isNum(r.gainPct) ? ' (' + fmtPct(r.gainPct) + ')' : '') + '</span>') : '') +
        pfKv('Dividends', p.drip ? 'Reinvested (DRIP)' : 'Paid as cash') +
        (function () {
          var hh = pfHistAll()[p.ticker];
          var buysHtml = '', headExtra = '';
          if (p.buys && p.buys.length) {
            var logged2 = 0;
            buysHtml = p.buys.map(function (b, bi) {
              logged2 += b.sh;
              var bk = pfDkey(new Date(b.d + 'T12:00:00'));
              var pxTxt = '';
              if (isNum(b.px)) pxTxt = ' @ ' + fmtMoney(b.px);
              else if (hh) { for (var z = 0; z < hh.pts.length; z++) { if (hh.pts[z][0] <= bk) pxTxt = ' @ ' + fmtMoney(hh.pts[z][1]); else break; } }
              return '<div class="pf-buy-row"><button class="pf-buy-txt" data-pf-buyedit="' + esc(p.ticker) + '|' + bi + '"><span>' + esc(b.d) + '</span><span>' + fmtShares(b.sh) + ' shares' + pxTxt + '</span></button><button class="link-btn danger pf-buy-del" data-pf-buydel="' + esc(p.ticker) + '|' + bi + '">\u2715</button></div>';
            }).join('');
            var grossD = p.shares + pfSoldShares(p);
            headExtra = ' <span class="pf-buys-n">' + fmtShares(Math.min(logged2, grossD)) + ' / ' + fmtShares(grossD) + ' shares logged</span>';
            var rem2 = grossD - logged2;
            if (rem2 > 0.0001) {
              var ek3 = hh ? pfEstKeyFor(p, hh) : null;
              buysHtml += '<div class="pf-buy-row"><span>Remaining</span><span>' + fmtShares(rem2) + ' shares \u2014 ' + (ek3 ? (p.estOverride ? 'set to ' + pfFmtDate(ek3) + ' (edited)' : 'est. ' + pfFmtDate(ek3) + ' (from avg cost)') : 'dated with your earliest purchase') + '</span>' +
                (hh ? '<button class="link-btn pf-buy-del" data-pf-estedit="' + esc(p.ticker) + '">Edit date</button>' : '') + '</div>';
            }
          } else if (hh && (isNum(p.cost) || p.estOverride)) {
            var ekA = pfEstKeyFor(p, hh);
            if (ekA) buysHtml = '<div class="pf-buy-row"><span>' + (p.estOverride ? 'Purchase date' : 'Est. purchase') + '</span><span>' + pfFmtDate(ekA) + (p.estOverride ? ' (edited)' : ' (from your avg cost)') + '</span>' +
              '<button class="link-btn pf-buy-del" data-pf-estedit="' + esc(p.ticker) + '">Edit date</button>' +
              (p.estOverride ? '<button class="link-btn danger" data-pf-estreset="' + esc(p.ticker) + '">Reset</button>' : '') + '</div>';
          }
          return '<div class="pf-buys"><div class="pf-buys-h"><span>Purchases' + headExtra + '</span><button class="link-btn" data-pf-buyadd="' + esc(p.ticker) + '">\uff0b Add purchase</button></div>' + buysHtml + '</div>';
        })() +
        (function () {
          var hh2 = pfHistAll()[p.ticker];
          var sl = p.sells || [];
          var rowsH = sl.map(function (s, si) {
            var sp2 = isNum(s.px) ? s.px : (hh2 ? pfPriceAt(hh2.pts, pfDkey(new Date(s.d + 'T12:00:00'))) : null);
            return '<div class="pf-buy-row"><button class="pf-buy-txt" data-pf-selledit="' + esc(p.ticker) + '|' + si + '"><span>' + esc(s.d) + '</span><span>Sold ' + fmtShares(s.sh) + (isNum(sp2) ? ' @ ' + fmtMoney(sp2) : '') + '</span></button><button class="link-btn danger pf-buy-del" data-pf-selldel="' + esc(p.ticker) + '|' + si + '">\u2715</button></div>';
          }).join('');
          var rz = pfRealized(p, hh2);
          var foot = (rz && isNum(rz.gain)) ? '<div class="pf-buy-row"><span>Realized</span><span class="' + (rz.gain >= 0 ? 'up' : 'down') + '">' + (rz.gain >= 0 ? '+' : '') + fmtMoney(rz.gain, 0) + (isNum(rz.pct) ? ' (' + fmtPct(rz.pct) + ')' : '') + '</span></div>' : '';
          return '<div class="pf-buys"><div class="pf-buys-h"><span>Sales</span><button class="link-btn" data-pf-selladd="' + esc(p.ticker) + '">\uff0b Add sale</button></div>' + rowsH + foot + '</div>';
        })() +
        (isNum(r.inc) ? pfKv('Est. dividend income', '\u2248 ' + fmtMoney(r.inc, 0) + '/yr') : '') +
        (p.drip && isNum(r.inc) && isNum(r.px) && r.px > 0 ? pfKv('DRIP buys', '\u2248 ' + fmtShares(r.inc / r.px) + ' shares/yr') : '') +
        '<div class="wl-actions"><button class="link-btn" data-pf-research="' + esc(p.ticker) + '">Research</button>' +
        '<button class="link-btn" data-pf-edit="' + esc(p.ticker) + '">Edit</button>' +
        '<button class="link-btn danger" data-pf-del="' + esc(p.ticker) + '">Remove</button></div>' +
      '</div>';
    }
    rowH += '</div>';
    if (isClosed) htmlClosed += rowH; else html += rowH;
  });
  listBox.innerHTML = html;
  var closedBox = $('pf-closed');
  if (closedBox) closedBox.innerHTML = htmlClosed ? '<h3 class="pf-closed-h">Closed positions</h3>' + htmlClosed : '';
  // Donut with label pills around it, Blossom-style. Slices group into
  // "Other" only when there are more than 8 holdings.
  var chartHtml = '';
  if (ranked.length && totVal > 0) {
    var slices = [], otherVal = 0, otherMembers = [];
    ranked.forEach(function (r, i) {
      if (ranked.length > 8 && i >= 7) { otherVal += r.val; otherMembers.push({ label: r.p.ticker, name: r.qt.name || r.p.ticker, val: r.val, col: colorOf[r.p.ticker] }); }
      else slices.push({ label: r.p.ticker, name: r.qt.name || r.p.ticker, val: r.val, col: colorOf[r.p.ticker], initial: r.p.ticker.charAt(0) });
    });
    if (otherVal > 0) slices.push({ label: 'Other', name: 'Other holdings', val: otherVal, col: '#5B7183', initial: '\u2022', members: otherMembers });
    var C = 2 * Math.PI * 78, off = 0, circles = '', pills = '';
    var mids = [];
    var sliceByLabel = {};
    slices.forEach(function (s) { sliceByLabel[s.label] = s; });
    slices.forEach(function (s) {
      var frac = s.val / totVal;
      var seg = Math.max(frac * C - 2, 0.5);
      circles += '<circle data-slice="' + esc(s.label) + '" cx="100" cy="100" r="78" fill="none" stroke="' + s.col + '" stroke-width="30" stroke-dasharray="' + seg.toFixed(1) + ' ' + (C - seg).toFixed(1) + '" stroke-dashoffset="' + (-off).toFixed(1) + '"/>';
      mids.push({ s: s, frac: frac, ang: (off + frac * C / 2) / C * 2 * Math.PI - Math.PI / 2 });
      off += frac * C;
    });
    // Label placement: every pill sits centered on its own slice's
    // mid-angle. Neighbours that would collide (tiny slices side by
    // side) are relaxed apart by the smallest possible nudge, split
    // evenly between the pair, so centering is preserved as closely
    // as physics allows.
    mids.sort(function (p, q2) { return p.ang - q2.ang; });
    var GAP = 0.30;
    for (var it = 0; it < 12 && mids.length > 1; it++) {
      var moved = false;
      for (var i3 = 1; i3 < mids.length; i3++) {
        var need = mids[i3 - 1].ang + GAP - mids[i3].ang;
        if (need > 0) { mids[i3 - 1].ang -= need / 2; mids[i3].ang += need / 2; moved = true; }
      }
      var wrapGap = (mids[0].ang + 2 * Math.PI) - mids[mids.length - 1].ang;
      if (wrapGap < GAP) { var wd = (GAP - wrapGap) / 2; mids[mids.length - 1].ang -= wd; mids[0].ang += wd; moved = true; }
      if (!moved) break;
    }
    mids.forEach(function (m) {
      var x = 50 + 44.5 * Math.cos(m.ang), y = 50 + 44.5 * Math.sin(m.ang);
      x = Math.min(90.5, Math.max(9.5, x)); y = Math.min(93.5, Math.max(6.5, y));
      pills += '<span class="pf-pill" style="left:' + x.toFixed(1) + '%;top:' + y.toFixed(1) + '%"><span class="pf-pill-dot" style="background:' + m.s.col + ';color:' + pfInk(m.s.col) + '">' + esc(m.s.initial) + (m.s.label !== 'Other' ? pfLogoImg(m.s.label) : '') + '</span>' + fmtNum(m.frac * 100, 0) + '%</span>';
    });
    // Donut center = today's move (Justin's pick, 2026-10-26): the
    // total value already headlines the card, so the center carries
    // the day's dollar move (big) and its weighted % (label).
    var dayDol = null;
    rows.forEach(function (r) {
      if (!r.closed && isNum(r.val) && isNum(r.qt.dayChg)) dayDol = (dayDol || 0) + r.val * r.qt.dayChg / (100 + r.qt.dayChg);
    });
    var center;
    if (isNum(dayDol) && isNum(dayPct)) {
      var dSign = dayDol > 0 ? '+' : (dayDol < 0 ? '\u2212' : '');
      var dFill = dayDol > 0 ? 'var(--neon-up)' : (dayDol < 0 ? 'var(--neon-dn)' : 'var(--chart-val)');
      center = '<text x="100" y="103" text-anchor="middle" class="pf-c-v" style="fill:' + dFill + '">' + fmtPct(dayPct) + '</text>' +
        '<text x="100" y="126" text-anchor="middle" class="pf-c-l">TODAY \u00b7 ' + dSign + fmtMoney(Math.abs(dayDol), 0) + '</text>';
    } else {
      center = '<text x="100" y="103" text-anchor="middle" class="pf-c-v">' + fmtMoney(totVal, 0) + '</text><text x="100" y="126" text-anchor="middle" class="pf-c-l">TOTAL VALUE</text>';
    }
    chartHtml = '<div class="pf-donut"><svg viewBox="0 0 200 200" role="img" aria-label="Portfolio allocation chart"><g transform="rotate(-90 100 100)">' + circles + '</g>' + center + '</svg>' + pills + '</div><div class="pf-pop" hidden></div>';
  }
  var yld = (anyPx && totVal > 0) ? totInc / totVal * 100 : null;
  var totGain = totVal - totCost;
  sumBox.innerHTML = '<div class="card"><div class="pf-sum-v">' + (anyPx ? fmtMoney(totVal, 0) : '\u2014') + '</div>' +
    '<div class="wl-meta">Total value \u00b7 ' + rows.filter(function (r) { return !r.closed; }).length + ' holding' + (rows.filter(function (r) { return !r.closed; }).length === 1 ? '' : 's') + '</div>' +
    '<div class="pf-sum-row"><span>Est. dividends <b>' + fmtMoney(totInc, 0) + '/yr</b>' + (isNum(yld) ? ' \u00b7 ' + fmtNum(yld, 2) + '% yield' : '') + '</span>' +
    (anyCost && totCost > 0 ? '<span>Total gain/loss <b class="' + (totGain >= 0 ? 'up' : 'down') + '">' + (totGain >= 0 ? '+' : '') + fmtMoney(totGain, 0) + ' (' + fmtPct(totGain / totCost * 100) + ')</b></span>' : '') +
    '</div>' + chartHtml + '</div>';
  var popEl = sumBox.querySelector('.pf-pop');
  var circEls = sumBox.querySelectorAll('[data-slice]');
  circEls.forEach(function (c) {
    c.addEventListener('click', function () {
      var label = c.getAttribute('data-slice');
      var wasOn = c.getAttribute('data-on') === '1';
      circEls.forEach(function (o) { o.style.opacity = ''; o.removeAttribute('data-on'); });
      if (wasOn) { if (popEl) popEl.hidden = true; return; }
      c.setAttribute('data-on', '1');
      circEls.forEach(function (o) { if (o !== c) o.style.opacity = '0.35'; });
      var s = sliceByLabel[label];
      if (popEl && s) {
        popEl.onclick = null;
        popEl.classList.remove('clickable');
        var popHtml = '<b>' + esc(s.name) + '</b><span>' + esc(s.label) + ' \u00b7 ' + fmtNum(s.val / totVal * 100, 1) + '% of portfolio \u00b7 ' + fmtMoney(s.val, 0) + '</span>';
        if (s.members && s.members.length) {
          popHtml += '<span class="pf-pop-hint">Tap here to see the holdings inside \u25be</span><div class="pf-pop-list" hidden>' +
            s.members.map(function (mb) {
              return '<div class="pf-pop-row"><span class="pf-pop-dot" style="background:' + mb.col + '"></span><b>' + esc(mb.label) + '</b><span class="pf-pop-row-n">' + esc(mb.name) + '</span><span>' + fmtNum(mb.val / totVal * 100, 1) + '% \u00b7 ' + fmtMoney(mb.val, 0) + '</span></div>';
            }).join('') + '</div>';
          popEl.classList.add('clickable');
          popEl.onclick = function () {
            var lst = popEl.querySelector('.pf-pop-list');
            var hint = popEl.querySelector('.pf-pop-hint');
            if (lst) {
              lst.hidden = !lst.hidden;
              if (hint) hint.textContent = lst.hidden ? 'Tap here to see the holdings inside \u25be' : 'Tap here to hide the holdings inside \u25b4';
            }
          };
        }
        popEl.innerHTML = popHtml;
        popEl.hidden = false;
      }
    });
  });
  document.querySelectorAll('[data-pf-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var T = b.getAttribute('data-pf-toggle');
      pfOpen[T] = !pfOpen[T];
      renderPortfolio(false);
    });
  });
  renderBench(doFetch);
  document.querySelectorAll('[data-pf-research]').forEach(function (b) {
    b.addEventListener('click', function () { switchTab('scorecard'); $('search-input').value = b.getAttribute('data-pf-research'); runSearch(b.getAttribute('data-pf-research')); });
  });
  document.querySelectorAll('[data-pf-del]').forEach(function (b) {
    b.addEventListener('click', function () {
      setPortfolio(getPortfolio().filter(function (x) { return x.ticker !== b.getAttribute('data-pf-del'); }));
      renderPortfolio(false);
    });
  });
  document.querySelectorAll('[data-pf-buyadd]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var T = b.getAttribute('data-pf-buyadd');
      var d = window.prompt('Purchase date for ' + T + ' (YYYY-MM-DD):', pfKeyToISO(pfDkey(new Date())));
      if (d === null) return;
      d = String(d).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d + 'T12:00:00').getTime())) { window.alert('That date does not look right -- use YYYY-MM-DD, like 2025-03-14.'); return; }
      var pf = getPortfolio();
      var pos = pf.filter(function (x) { return x.ticker === T; })[0];
      if (!pos) return;
      var logged = (pos.buys || []).reduce(function (a2, b2) { return a2 + b2.sh; }, 0);
      var grossB = pos.shares + pfSoldShares(pos);
      var remainB = grossB - logged;
      if (remainB <= 0) { window.alert('Every share of ' + T + ' is already assigned to a purchase date. Edit a purchase or raise the share count first.'); return; }
      var sh = await pfShareSheet('How many shares did you buy on ' + d + '?', remainB, null);
      if (sh === null) return;
      if (!isNum(sh) || sh <= 0) { window.alert('Enter the number of shares bought.'); return; }
      if (logged + sh > grossB + 1e-9) {
        window.alert('That would make ' + fmtShares(logged + sh) + ' shares purchased, but ' + T + ' only accounts for ' + fmtShares(grossB) + ' in total (' + fmtShares(pos.shares) + ' held + ' + fmtShares(pfSoldShares(pos)) + ' sold). Enter fewer shares, or update the holding first with Edit.');
        return;
      }
      var prB = window.prompt('Purchase price per share for ' + T + ' ($, blank = that day\u2019s closing price):', '');
      if (prB === null) return;
      var pxB = parseFloat(prB);
      if (!pos.buys) pos.buys = [];
      var entryB = { d: d, sh: sh };
      if (isNum(pxB) && pxB > 0) entryB.px = pxB;
      pos.buys.push(entryB);
      pos.buys.sort(function (x, y) { return x.d < y.d ? -1 : 1; });
      setPortfolio(pf);
      renderPortfolio(false);
    });
  });
  document.querySelectorAll('[data-pf-buydel]').forEach(function (b) {
    b.addEventListener('click', function () {
      var parts = b.getAttribute('data-pf-buydel').split('|');
      var pf = getPortfolio();
      var pos = pf.filter(function (x) { return x.ticker === parts[0]; })[0];
      if (pos && pos.buys) pos.buys.splice(parseInt(parts[1], 10), 1);
      setPortfolio(pf);
      renderPortfolio(false);
    });
  });
  document.querySelectorAll('[data-pf-selladd]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var T = b.getAttribute('data-pf-selladd');
      var d = window.prompt('Sale date for ' + T + ' (YYYY-MM-DD):', pfKeyToISO(pfDkey(new Date())));
      if (d === null) return;
      d = String(d).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d + 'T12:00:00').getTime())) { window.alert('That date does not look right -- use YYYY-MM-DD, like 2025-03-14.'); return; }
      var pf = getPortfolio();
      var pos = pf.filter(function (x) { return x.ticker === T; })[0];
      if (!pos) return;
      var bought = (pos.buys || []).reduce(function (a2, b2) { return a2 + b2.sh; }, 0);
      var remainS = bought - pfSoldShares(pos);
      // All = the remaining sellable shares: from logged purchases
      // when they exist, otherwise the whole current holding (the
      // button was missing entirely for unlogged positions).
      var capSell = bought > 0 ? (remainS > 0 ? remainS : null) : (pos.shares > 0 ? pos.shares : null);
      var sh = await pfShareSheet('How many shares of ' + T + ' did you sell on ' + d + '?', capSell, null);
      if (sh === null) return;
      if (!isNum(sh) || sh <= 0) { window.alert('Enter the number of shares sold.'); return; }
      if (bought > 0 && pfSoldShares(pos) + sh > bought + 1e-9) {
        window.alert('Your logged purchases for ' + T + ' add up to ' + fmtShares(bought) + ' shares, so sales cannot pass that. Add the missing purchases first.');
        return;
      }
      var pr = window.prompt('Sale price per share for ' + T + ' ($, blank = that day\u2019s closing price):', '');
      if (pr === null) return;
      var px = parseFloat(pr);
      if (!pos.sells) pos.sells = [];
      var entry = { d: d, sh: sh };
      if (isNum(px) && px > 0) entry.px = px;
      pos.sells.push(entry);
      pos.sells.sort(function (x, y) { return x.d < y.d ? -1 : 1; });
      setPortfolio(pf);
      renderPortfolio(false);
    });
  });
  document.querySelectorAll('[data-pf-selldel]').forEach(function (b) {
    b.addEventListener('click', function () {
      var parts = b.getAttribute('data-pf-selldel').split('|');
      var pf = getPortfolio();
      var pos = pf.filter(function (x) { return x.ticker === parts[0]; })[0];
      if (pos && pos.sells) pos.sells.splice(parseInt(parts[1], 10), 1);
      setPortfolio(pf);
      renderPortfolio(false);
    });
  });
  document.querySelectorAll('[data-pf-buyedit]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var parts = b.getAttribute('data-pf-buyedit').split('|');
      var pf = getPortfolio();
      var pos = pf.filter(function (x) { return x.ticker === parts[0]; })[0];
      if (!pos || !pos.buys) return;
      var idx = parseInt(parts[1], 10), cur = pos.buys[idx];
      if (!cur) return;
      var d = window.prompt('Purchase date for ' + parts[0] + ' (YYYY-MM-DD):', cur.d);
      if (d === null) return;
      d = String(d).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d + 'T12:00:00').getTime())) { window.alert('That date does not look right -- use YYYY-MM-DD, like 2025-03-14.'); return; }
      var others = pos.buys.reduce(function (a2, b2, i2) { return a2 + (i2 === idx ? 0 : b2.sh); }, 0);
      var capB = pos.shares + pfSoldShares(pos) - others;
      var sh = await pfShareSheet('How many shares did you buy on ' + d + '?', capB, cur.sh);
      if (sh === null) return;
      if (!isNum(sh) || sh <= 0) { window.alert('Enter the number of shares bought.'); return; }
      if (others + sh > pos.shares + pfSoldShares(pos) + 1e-9) { window.alert('That would put purchases past the total shares this position accounts for. Raise the share count or lower the amount.'); return; }
      var prE = window.prompt('Purchase price per share for ' + parts[0] + ' ($, blank = that day\u2019s closing price):', isNum(cur.px) ? cur.px : '');
      if (prE === null) return;
      var pxE = parseFloat(prE);
      var entryE = { d: d, sh: sh };
      if (isNum(pxE) && pxE > 0) entryE.px = pxE;
      pos.buys[idx] = entryE;
      pos.buys.sort(function (x, y) { return x.d < y.d ? -1 : 1; });
      setPortfolio(pf);
      renderPortfolio(false);
    });
  });
  document.querySelectorAll('[data-pf-selledit]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var parts = b.getAttribute('data-pf-selledit').split('|');
      var pf = getPortfolio();
      var pos = pf.filter(function (x) { return x.ticker === parts[0]; })[0];
      if (!pos || !pos.sells) return;
      var idx = parseInt(parts[1], 10), cur = pos.sells[idx];
      if (!cur) return;
      var d = window.prompt('Sale date for ' + parts[0] + ' (YYYY-MM-DD):', cur.d);
      if (d === null) return;
      d = String(d).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d + 'T12:00:00').getTime())) { window.alert('That date does not look right -- use YYYY-MM-DD, like 2025-03-14.'); return; }
      var bought = (pos.buys || []).reduce(function (a2, b2) { return a2 + b2.sh; }, 0);
      var otherSells = pos.sells.reduce(function (a2, b2, i2) { return a2 + (i2 === idx ? 0 : b2.sh); }, 0);
      var capS = bought - otherSells;
      var capSellE = bought > 0 ? capS : (pos.shares + cur.sh > 0 ? pos.shares + cur.sh : null);
      var sh = await pfShareSheet('How many shares did you sell on ' + d + '?', capSellE, cur.sh);
      if (sh === null) return;
      if (!isNum(sh) || sh <= 0) { window.alert('Enter the number of shares sold.'); return; }
      if (bought > 0 && otherSells + sh > bought + 1e-9) { window.alert('Sales cannot pass your logged purchases for ' + parts[0] + ' (' + fmtShares(bought) + ' shares).'); return; }
      var pr = window.prompt('Sale price per share for ' + parts[0] + ' ($, blank = that day\u2019s closing price):', isNum(cur.px) ? cur.px : '');
      if (pr === null) return;
      var px = parseFloat(pr);
      var entry = { d: d, sh: sh };
      if (isNum(px) && px > 0) entry.px = px;
      pos.sells[idx] = entry;
      pos.sells.sort(function (x, y) { return x.d < y.d ? -1 : 1; });
      setPortfolio(pf);
      renderPortfolio(false);
    });
  });
  document.querySelectorAll('[data-pf-estedit]').forEach(function (b) {
    b.addEventListener('click', function () {
      var T = b.getAttribute('data-pf-estedit');
      var pf = getPortfolio();
      var pos = pf.filter(function (x) { return x.ticker === T; })[0];
      if (!pos) return;
      var hh = pfHistAll()[T];
      var cur = hh ? pfEstKeyFor(pos, hh) : null;
      var d = window.prompt('Purchase date for ' + T + ' (YYYY-MM-DD). This replaces the estimate for any shares you have not logged purchases for:', cur ? pfKeyToISO(cur) : '');
      if (d === null) return;
      d = String(d).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d + 'T12:00:00').getTime())) { window.alert('That date does not look right -- use YYYY-MM-DD, like 2025-03-14.'); return; }
      pos.estOverride = d;
      setPortfolio(pf);
      renderPortfolio(false);
    });
  });
  document.querySelectorAll('[data-pf-estreset]').forEach(function (b) {
    b.addEventListener('click', function () {
      var T = b.getAttribute('data-pf-estreset');
      var pf = getPortfolio();
      var pos = pf.filter(function (x) { return x.ticker === T; })[0];
      if (!pos) return;
      delete pos.estOverride;
      setPortfolio(pf);
      renderPortfolio(false);
    });
  });
  document.querySelectorAll('[data-pf-edit]').forEach(function (b) {
    b.addEventListener('click', function () {
      var T = b.getAttribute('data-pf-edit');
      var pf = getPortfolio();
      var pos = pf.filter(function (x) { return x.ticker === T; })[0];
      if (!pos) return;
      var s = window.prompt('How many shares of ' + T + ' do you own?', pos.shares);
      if (s === null) return;
      var ns = parseFloat(s);
      if (isNum(ns) && ns >= 0) pos.shares = ns;
      var c = window.prompt('Average cost per share for ' + T + ' ($, leave blank for none):', isNum(pos.cost) ? pos.cost : '');
      if (c !== null) { var nc = parseFloat(c); pos.cost = isNum(nc) ? nc : null; }
      var dr = window.prompt('Are dividends reinvested for ' + T + '? Type yes or no:', pos.drip ? 'yes' : 'no');
      if (dr !== null) pos.drip = /^y/i.test(String(dr).trim());
      var bt = (pos.buys || []).reduce(function (a3, b3) { return a3 + b3.sh; }, 0);
      if (bt > pos.shares + pfSoldShares(pos) + 1e-9) {
        window.alert('Your logged purchases for ' + T + ' add up to ' + fmtShares(bt) + ' shares, more than the ' + fmtShares(pos.shares) + ' you entered here. Remove some purchases first, or enter a higher share count. Nothing was changed.');
        return;
      }
      setPortfolio(pf);
      renderPortfolio(false);
    });
  });
}

/* ============================== portfolio vs S&P 500 ============================== */
/* Benchmark tracker: rebuilds the portfolio's daily value from the
 * share counts entered (held constant) and races it against SPY.
 * Price return only -- dividends are not in the lines. */
var PF_HIST_KEY = 'sr_pfhist_v1';
var PF_HIST5_KEY = 'sr_pfhist5_v1';
var PF_BENCH_KEY = 'sr_pfbench_v1';
var pfBenchBusy = false;
function pfHistAll() { return lsGet(PF_HIST_KEY, {}); }
function pfHist5All() { return lsGet(PF_HIST5_KEY, {}); }
/* Long comparison periods (5Y/10Y/15Y) share the weekly history cache;
 * returns the span in years, or 0 for the daily short periods. */
function pfLongYears(period) { return period === '5Y' ? 5 : period === '10Y' ? 10 : period === '15Y' ? 15 : 0; }
function pfBenchPeriod() { return lsGet(PF_BENCH_KEY, '1Y'); }
function pfDkey(dt) { return dt.getFullYear() * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate(); }

async function fetchPfHist(T, range, interval) {
  var ch = await relayJSON('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(T) + '?range=' + (range || '1y') + '&interval=' + (interval || '1d'));
  var res = ch && ch.chart && ch.chart.result && ch.chart.result[0];
  if (!res || !res.timestamp) throw new Error('no history');
  var closes = (res.indicators && res.indicators.quote && res.indicators.quote[0].close) || [];
  var pts = [];
  res.timestamp.forEach(function (ts, i) {
    if (isNum(closes[i])) pts.push([pfDkey(new Date(ts * 1000)), Math.round(closes[i] * 100) / 100]);
  });
  if (pts.length < 10) throw new Error('thin history');
  return { ts: Date.now(), pts: pts };
}

function paintBench(box, hist, positions) {
  var spy = hist['SPY'];
  if (!spy || !spy.pts || spy.pts.length < 10) { box.innerHTML = ''; return; }
  var period = pfBenchPeriod();
  var days = period === '1M' ? 31 : period === '3M' ? 93 : period === '6M' ? 186 : period === '5Y' ? 1827 : period === '10Y' ? 3652 : period === '15Y' ? 5478 : 370;
  var endKey = spy.pts[spy.pts.length - 1][0];
  var endDt = new Date(Math.floor(endKey / 10000), Math.floor(endKey / 100) % 100 - 1, endKey % 100);
  var cutDt = new Date(endDt); cutDt.setDate(cutDt.getDate() - days);
  var cut = pfDkey(cutDt);
  var win = spy.pts.filter(function (p) { return p[0] >= cut; });
  if (win.length < 2) win = spy.pts.slice(-2);

  // Forward-fill price lookup over a [[dateKey, close], ...] series.
  function priceFn(pts) {
    var i = 0, last = null;
    return function (d) {
      if (!pts) return null;
      while (i < pts.length && pts[i][0] <= d) { last = pts[i][1]; i++; }
      return last;
    };
  }
  function priceAt(pts, d) {
    if (!pts) return null;
    var last = null;
    for (var i = 0; i < pts.length && pts[i][0] <= d; i++) last = pts[i][1];
    return last != null ? last : (pts.length ? pts[0][1] : null);
  }

  // Build purchase lots: the user's manual entries where they exist,
  // otherwise one estimated lot (all shares at the date the price last
  // matched the average cost). No lots at all -> constant-shares mode.
  var lots = [], sellEvents = [], excluded = 0, estUsed = 0, manualUsed = 0;
  var w0 = win[0][0];
  positions.forEach(function (p) {
    var hh = hist[p.ticker];
    var gross = p.shares + pfSoldShares(p);
    if (hh && p.sells) p.sells.forEach(function (s) { var sd = pfDkey(new Date(s.d + 'T12:00:00')); sellEvents.push({ d: sd, t: p.ticker, sh: s.sh, px: isNum(s.px) ? s.px : priceAt(hh.pts, sd) }); });
    if (p.buys && p.buys.length) {
      if (!hh) { excluded++; return; }
      var room = gross, firstD = null;
      p.buys.slice().sort(function (x, y) { return x.d < y.d ? -1 : 1; }).forEach(function (b) {
        if (room <= 0) return;
        var take = Math.min(b.sh, room);
        var bd = pfDkey(new Date(b.d + 'T12:00:00'));
        if (firstD === null) firstD = bd;
        var bp = priceAt(hh.pts, bd);
        lots.push({ d: bd, t: p.ticker, sh: take, amt: isNum(b.px) ? take * b.px : (isNum(bp) ? take * bp : (isNum(p.cost) ? take * p.cost : 0)), pre: bd < w0 });
        room -= take;
      });
      manualUsed++;
      if (room > 0) {
        var ek2 = pfEstKeyFor(p, hh);
        if (ek2) { var ep2 = priceAt(hh.pts, ek2); lots.push({ d: ek2, t: p.ticker, sh: room, amt: isNum(p.cost) ? room * p.cost : (isNum(ep2) ? room * ep2 : 0), pre: ek2 < w0 }); estUsed++; }
        else if (firstD !== null) { var fp = priceAt(hh.pts, firstD); lots.push({ d: firstD, t: p.ticker, sh: room, amt: isNum(fp) ? room * fp : 0, pre: firstD < w0 }); }
      }
    } else if (hh && (isNum(p.cost) || p.estOverride)) {
      var ek = pfEstKeyFor(p, hh);
      if (ek) { var ep = priceAt(hh.pts, ek); lots.push({ d: ek, t: p.ticker, sh: gross, amt: isNum(p.cost) ? gross * p.cost : (isNum(ep) ? gross * ep : 0), pre: ek < w0 }); estUsed++; }
      else excluded++;
    } else excluded++;
  });
  lots.sort(function (a, b) { return a.d - b.d; });

  var pfSeries = [], spySeries = [];
  if (lots.length) {
    // Fund-style (time-weighted) math: money enters the comparison on
    // the day it was spent, and a deposit never counts as a gain. The
    // line is a NAV that moves only with market performance; purchases
    // add holdings at cost without moving the NAV. The S&P line runs
    // the same span, so its NAV is the index's own price performance
    // while his money was invested.
    var owned = {};
    positions.forEach(function (p) { owned[p.ticker] = 0; });
    // One event stream (buys and sells in date order; sells first on a
    // tie). Sale proceeds become a cash balance inside the line and
    // fund later buys before any new money counts as injected.
    var evs = lots.map(function (l) { return { d: l.d, buy: true, lot: l }; })
      .concat(sellEvents.map(function (s) { return { d: s.d, buy: false, ev: s }; }))
      .sort(function (a, b) { return a.d - b.d || (a.buy === b.buy ? 0 : a.buy ? 1 : -1); });
    var cash = 0;
    function applyBuy(lot, fund) {
      if (fund) { var sp = Math.min(cash, lot.amt); cash -= sp; }
      owned[lot.t] += lot.sh;
    }
    function applySell(ev) {
      var take = Math.min(ev.sh, owned[ev.t] || 0);
      owned[ev.t] -= take;
      if (isNum(ev.px)) cash += take * ev.px;
    }
    var ei = 0;
    while (ei < evs.length && evs[ei].d < w0) { if (evs[ei].buy) applyBuy(evs[ei].lot, true); else applySell(evs[ei].ev); ei++; }
    var nav = 100, vPost = null, started = false;
    win.forEach(function (sp) {
      var d = sp[0];
      var V = cash;
      positions.forEach(function (p) {
        if (owned[p.ticker] > 0) { var px = priceAt(hist[p.ticker] ? hist[p.ticker].pts : null, d); if (isNum(px)) V += owned[p.ticker] * px; }
      });
      if (vPost != null && vPost > 0 && V > 0) nav *= V / vPost;
      var extFlow = 0;
      while (ei < evs.length && evs[ei].d <= d) {
        if (evs[ei].buy) { var before = cash; applyBuy(evs[ei].lot, true); extFlow += evs[ei].lot.amt - (before - cash); }
        else applySell(evs[ei].ev);
        ei++;
      }
      vPost = cash;
      positions.forEach(function (p) {
        if (owned[p.ticker] > 0) { var px2 = priceAt(hist[p.ticker] ? hist[p.ticker].pts : null, d); if (isNum(px2)) vPost += owned[p.ticker] * px2; }
      });
      if (!started && (V > 0 || vPost > 0)) started = true;
      pfSeries.push(started ? nav : null);
      spySeries.push(sp[1]);
    });
  } else {
    var series = positions.map(function (p) {
      var hh2 = hist[p.ticker];
      return { shares: p.shares, pts: hh2 ? hh2.pts : null, i: 0, last: null };
    });
    excluded = series.filter(function (s) { return !s.pts; }).length;
    win.forEach(function (sp) {
      var tot = 0, any = false;
      series.forEach(function (s) {
        if (!s.pts) return;
        while (s.i < s.pts.length && s.pts[s.i][0] <= sp[0]) { s.last = s.pts[s.i][1]; s.i++; }
        if (isNum(s.last)) { tot += s.shares * s.last; any = true; }
      });
      pfSeries.push(any ? tot : null);
      spySeries.push(sp[1]);
    });
  }
  var k0 = -1;
  for (var kk = 0; kk < win.length; kk++) { if (isNum(pfSeries[kk]) && isNum(spySeries[kk])) { k0 = kk; break; } }
  if (k0 < 0 || win.length - k0 < 2) { box.innerHTML = ''; return; }
  var pfIdx = [], spyIdx = [];
  for (var k = k0; k < win.length; k++) {
    pfIdx.push(pfSeries[k] / pfSeries[k0] * 100);
    spyIdx.push(spySeries[k] / spySeries[k0] * 100);
  }
  var pfLine = [], spyLine = [];
  for (var k2 = 0; k2 < win.length; k2++) {
    pfLine.push(k2 >= k0 && isNum(pfSeries[k2]) ? pfSeries[k2] / pfSeries[k0] * 100 : null);
    spyLine.push(k2 >= k0 && isNum(spySeries[k2]) ? spySeries[k2] / spySeries[k0] * 100 : null);
  }
  var pfRet = pfIdx[pfIdx.length - 1] - 100, spyRet = spyIdx[spyIdx.length - 1] - 100;
  var gap = pfRet - spyRet;
  var all = pfIdx.concat(spyIdx);
  var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all), pad = (hi - lo) * 0.08 + 0.5;
  lo -= pad; hi += pad;
  function X(i) { return (6 + i / (pfIdx.length - 1) * 328).toFixed(1); }
  function Y(v) { return (164 - (v - lo) / (hi - lo) * 158).toFixed(1); }
  function line(arr) { return arr.map(function (v, i) { return isNum(v) ? X(i) + ',' + Y(v) : null; }).filter(Boolean).join(' '); }
  // X-axis ticks: day numbers on the 1M view, months for the
  // sub-year ranges, years only on the 5Y view.
  var MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var tickIdx = [0, 0.25, 0.5, 0.75, 1].map(function (f) { return Math.round(f * (win.length - 1)); }).filter(function (v, i, a) { return a.indexOf(v) === i; });
  var prevYr = null;
  var ticksSvg = tickIdx.map(function (ti, ord) {
    var key = win[ti][0];
    var yr = Math.floor(key / 10000), mo = Math.floor(key / 100) % 100, dy = key % 100;
    var lab;
    if (pfLongYears(period)) lab = String(yr);
    else if (period === '1M') lab = MONS[mo - 1] + ' ' + dy;
    else { lab = MONS[mo - 1] + (prevYr === null || yr !== prevYr ? " '" + String(yr).slice(2) : ''); prevYr = yr; }
    var anchor = ord === 0 ? 'start' : ord === tickIdx.length - 1 ? 'end' : 'middle';
    var tx = ord === 0 ? 6 : ord === tickIdx.length - 1 ? 334 : X(ti - k0);
    return '<text x="' + tx + '" y="179" font-size="8.5" style="fill:var(--muted)" text-anchor="' + anchor + '">' + lab + '</text>';
  }).join('');
  var chips = ['1M', '3M', '6M', '1Y', '5Y', '10Y', '15Y'].map(function (p) {
    return '<button type="button" data-bench="' + p + '"' + (p === period ? ' class="active"' : '') + '>' + p + '</button>';
  }).join('');
  var modeNote = lots.length
    ? 'Fund-style math: money joins the comparison on the day you spent it, and a deposit never counts as a gain -- the percentages are pure performance of your money while it was invested, and sale proceeds sit as cash in your line until you re-spend them. The S&amp;P line is the index over the same span.' +
      (manualUsed ? ' ' + manualUsed + ' holding(s) use your entered purchase dates.' : '') +
      (estUsed ? ' ' + estUsed + ' use a date estimated from your average cost (the last day the price matched it).' : '') +
      ' Price return only, dividends not included.'
    : 'Both lines start at 100. Your line is rebuilt from the share counts you entered, held constant over the period -- add purchase dates (or an average cost) on a holding to date it properly. Price return only, dividends not included. S&amp;P 500 tracked via SPY.';
  box.innerHTML = '<div class="card">' +
    '<div class="pf-bench-head"><span class="pf-bench-title">Portfolio vs S&amp;P 500</span>' +
    '<span class="pf-bench-legend"><span><span class="pf-bench-dot" style="background:#F8C73D"></span>You</span><span><span class="pf-bench-dot" style="background:#61A5C2"></span>S&amp;P 500</span></span></div>' +
    '<div class="seg pf-bench-seg" role="group" aria-label="Benchmark period">' + chips + '</div>' +
    '<div id="pf-bench-read" class="pf-bench-read">Drag across the chart to see any day.</div>' +
    '<svg class="pf-bench-chart" viewBox="0 0 340 186" role="img" aria-label="Portfolio versus S&P 500 chart">' +
    '<polyline points="' + line(spyLine) + '" fill="none" stroke="#61A5C2" stroke-width="2" stroke-linejoin="round"/>' +
    '<polyline points="' + line(pfLine) + '" fill="none" stroke="#F8C73D" stroke-width="2.5" stroke-linejoin="round"/>' +
    '<circle cx="' + X(win.length - 1) + '" cy="' + Y(pfIdx[pfIdx.length - 1]) + '" r="3.2" fill="#F8C73D"/>' +
    '<circle cx="' + X(win.length - 1) + '" cy="' + Y(spyIdx[spyIdx.length - 1]) + '" r="3" fill="#61A5C2"/>' + ticksSvg +
    '<g id="pf-scrub" style="display:none"><line id="pf-scrub-line" y1="4" y2="166" stroke-width="1" stroke-dasharray="3 3" style="stroke:var(--muted)"/>' +
    '<circle id="pf-scrub-pf" r="4.2" fill="#F8C73D" stroke="#0d0d0f" stroke-width="1.5"/>' +
    '<circle id="pf-scrub-spy" r="3.8" fill="#61A5C2" stroke="#0d0d0f" stroke-width="1.5"/></g>' +
    '<rect id="pf-scrub-zone" x="0" y="0" width="340" height="172" fill="transparent" style="touch-action:none"/></svg>' +
    '<div class="pf-bench-stats"><span>You <b class="' + (pfRet >= 0 ? 'up' : 'down') + '">' + fmtPct(pfRet) + '</b></span>' +
    '<span>S&amp;P 500 <b class="' + (spyRet >= 0 ? 'up' : 'down') + '">' + fmtPct(spyRet) + '</b></span>' +
    '<span>' + (gap >= 0 ? 'Ahead by' : 'Behind by') + ' <b class="' + (gap >= 0 ? 'up' : 'down') + '">' + fmtNum(Math.abs(gap), 1) + ' pts</b></span></div>' +
    '<p class="fineprint" style="margin:8px 0 0">' + modeNote +
    (excluded ? ' ' + excluded + ' holding(s) left out (no purchase dates or average cost to date them).' : '') + '</p></div>';
  box.querySelectorAll('[data-bench]').forEach(function (b) {
    b.addEventListener('click', function () {
      lsSet(PF_BENCH_KEY, b.getAttribute('data-bench'));
      renderBench(false);
    });
  });
  var svgEl = box.querySelector('.pf-bench-chart');
  var zone = box.querySelector('#pf-scrub-zone');
  var grp = box.querySelector('#pf-scrub');
  var read = box.querySelector('#pf-bench-read');
  if (svgEl && zone && grp && read) {
    var sLn = box.querySelector('#pf-scrub-line');
    var cPf = box.querySelector('#pf-scrub-pf');
    var cSpy = box.querySelector('#pf-scrub-spy');
    var scrubbing = false;
    function scrubTo(clientX) {
      var rect = svgEl.getBoundingClientRect();
      if (!rect.width) return;
      var sx = (clientX - rect.left) / rect.width * 340;
      var i = Math.round((sx - 6) / 328 * (pfIdx.length - 1));
      i = Math.max(k0, Math.min(win.length - 1, i));
      while (i > k0 && !isNum(pfLine[i])) i--;
      if (!isNum(pfLine[i]) || !isNum(spyLine[i])) return;
      var x = X(i);
      grp.style.display = '';
      sLn.setAttribute('x1', x); sLn.setAttribute('x2', x);
      cPf.setAttribute('cx', x); cPf.setAttribute('cy', Y(pfLine[i]));
      cSpy.setAttribute('cx', x); cSpy.setAttribute('cy', Y(spyLine[i]));
      var key = win[i][0];
      var yr = Math.floor(key / 10000), mo = Math.floor(key / 100) % 100, dy = key % 100;
      var pv = pfLine[i] - 100, sv2 = spyLine[i] - 100;
      read.innerHTML = '<b class="pf-read-date">' + MONS[mo - 1] + ' ' + dy + ', ' + yr + '</b> \u00b7 You <b class="' + (pv >= 0 ? 'up' : 'down') + '">' + fmtPct(pv) + '</b> \u00b7 S&amp;P <b class="' + (sv2 >= 0 ? 'up' : 'down') + '">' + fmtPct(sv2) + '</b> \u00b7 ' + (pv - sv2 >= 0 ? 'Ahead' : 'Behind') + ' <b class="' + (pv - sv2 >= 0 ? 'up' : 'down') + '">' + fmtNum(Math.abs(pv - sv2), 1) + ' pts</b>';
    }
    zone.addEventListener('pointerdown', function (e) { scrubbing = true; try { zone.setPointerCapture(e.pointerId); } catch (err) {} scrubTo(e.clientX); e.preventDefault(); });
    zone.addEventListener('pointermove', function (e) { if (scrubbing) scrubTo(e.clientX); });
    zone.addEventListener('pointerup', function () { scrubbing = false; });
    zone.addEventListener('pointercancel', function () { scrubbing = false; });
  }
}

async function renderBench(force) {
  var box = $('pf-bench');
  if (!box) return;
  var positions = getPortfolio();
  if (!positions.length) { box.innerHTML = ''; return; }
  var period = pfBenchPeriod();
  var needYears = pfLongYears(period);
  var five = needYears > 0;
  var cacheKey = five ? PF_HIST5_KEY : PF_HIST_KEY;
  var hist = five ? pfHist5All() : pfHistAll();
  paintBench(box, hist, positions);
  var need = ['SPY'].concat(positions.map(function (p) { return p.ticker; }));
  var stale = need.some(function (t) { var hh = hist[t]; return !hh || (Date.now() - hh.ts > 12 * 3600 * 1000); });
  if (five) {
    var haveMeta = lsGet('sr_pfhist5_range', '');
    var haveYears = haveMeta === '15y' ? 15 : haveMeta === '5y' ? 5 : 0;
    if (haveYears < needYears) stale = true;
  }
  if ((force || stale) && !pfBenchBusy) {
    pfBenchBusy = true;
    if (!hist['SPY']) box.innerHTML = '<div class="card"><span class="spinner"></span>Loading the S&P 500 comparison\u2026</div>';
    var updated = {};
    Object.keys(hist).forEach(function (k) { updated[k] = hist[k]; });
    var fetchRange = five ? (Math.max(needYears, haveYears) <= 5 ? '5y' : '15y') : '1y';
    await Promise.all(need.map(async function (t) {
      try { updated[t] = await fetchPfHist(t, fetchRange, five ? '1wk' : '1d'); } catch (e) {}
    }));
    lsSet(cacheKey, updated);
    if (five) lsSet('sr_pfhist5_range', fetchRange);
    pfBenchBusy = false;
    if (pfLongYears(pfBenchPeriod()) > 0 === five) paintBench(box, five ? pfHist5All() : pfHistAll(), getPortfolio());
  }
}

/* ============================== journal ============================== */
var J_KEY = 'sr_journal_v1';
function getJournal() { return lsGet(J_KEY, {}); }
function setJournal(j) { lsSet(J_KEY, j); }
var editingTicker = null;
function startJournalEdit(T) {
  var j = getJournal();
  var e = j[T] || {};
  editingTicker = T;
  $('journal-editor-title').textContent = 'Entry — ' + T;
  $('j-ticker').value = T;
  $('j-ticker').readOnly = true;
  $('j-thesis').value = e.thesis || '';
  $('j-catalysts').value = e.catalysts || '';
  $('j-bull').value = e.bull || '';
  $('j-base').value = e.base || '';
  $('j-bear').value = e.bear || '';
  $('j-review').value = e.review || '';
  $('j-cancel').hidden = false;
  $('journal-editor-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function resetJournalForm() {
  editingTicker = null;
  $('journal-editor-title').textContent = 'New entry';
  $('j-ticker').readOnly = false;
  $('j-cancel').hidden = true;
  $('journal-form').reset();
}
function renderJournal() {
  var j = getJournal();
  var tickers = Object.keys(j).sort();
  var box = $('journal-list');
  if (!tickers.length) {
    box.innerHTML = '<div class="empty-note"><h2>No journal entries yet</h2><p>Write down your thesis before you buy — future you will want to know what past you was thinking. Entries live only on this device.</p></div>';
    return;
  }
  var html = '';
  tickers.forEach(function (T) {
    var e = j[T];
    html += '<div class="j-row"><h4>' + esc(T) + '</h4><div class="j-meta">' +
      (e.review ? 'Review by ' + esc(e.review) + ' · ' : '') + 'Updated ' + new Date(e.updatedAt || Date.now()).toLocaleDateString() + '</div>';
    if (e.thesis) html += '<p><span class="j-lab">Thesis</span><br>' + esc(e.thesis) + '</p>';
    if (e.catalysts) html += '<p><span class="j-lab">Catalysts</span><br>' + esc(e.catalysts) + '</p>';
    if (e.bull) html += '<p><span class="j-lab">Bull</span><br>' + esc(e.bull) + '</p>';
    if (e.base) html += '<p><span class="j-lab">Base</span><br>' + esc(e.base) + '</p>';
    if (e.bear) html += '<p><span class="j-lab">Bear</span><br>' + esc(e.bear) + '</p>';
    html += '<div><button class="link-btn" data-research="' + esc(T) + '">Research</button>' +
      '<button class="link-btn" data-j-edit="' + esc(T) + '">Edit</button>' +
      '<button class="link-btn danger" data-j-del="' + esc(T) + '">Delete</button></div></div>';
  });
  box.innerHTML = html;
  box.querySelectorAll('[data-research]').forEach(function (b) {
    b.addEventListener('click', function () { switchTab('scorecard'); $('search-input').value = b.getAttribute('data-research'); runSearch(b.getAttribute('data-research')); });
  });
  box.querySelectorAll('[data-j-edit]').forEach(function (b) {
    b.addEventListener('click', function () { startJournalEdit(b.getAttribute('data-j-edit')); });
  });
  box.querySelectorAll('[data-j-del]').forEach(function (b) {
    b.addEventListener('click', function () {
      var j2 = getJournal();
      delete j2[b.getAttribute('data-j-del')];
      setJournal(j2);
      renderJournal();
    });
  });
}

/* ============================== glossary ============================== */
var GLOSSARY = [
  ['P/E ratio', 'Price divided by earnings per share. What you pay for $1 of yearly profit. 20× means $20 per $1 of earnings.'],
  ['Forward P/E', 'Price divided by next year\'s expected earnings per share. Uses analyst estimates, so it\'s a guess about the future — cheaper-looking, but the estimate can be wrong.'],
  ['PEG ratio', 'P/E divided by the expected earnings growth rate. Tries to answer "am I overpaying for this growth?" Under 1 is traditionally "fair", under 0.5 is unusually cheap — or a warning that growth is about to fall off a cliff.'],
  ['Market cap', 'Share price × shares outstanding. The total price tag on the whole company. Your screen only looks at companies over $5B (large enough to be established).'],
  ['52-week high', 'The highest price in the last year. A stock 30% below it is on sale relative to recent sentiment — or something broke. Your screen wants 25%+ below, then the research decides which.'],
  ['EPS (earnings per share)', 'Company profit divided by shares. The single number most valuation math is built on. "TTM" = trailing twelve months (actual past). "Consensus" = the average of analyst estimates (guessed future).'],
  ['Earnings cliff', 'When a cyclical company\'s earnings peak, then fall hard — memory chips, miners, commodities. The stock looks cheapest (lowest P/E) exactly at the peak, right before earnings collapse. The most common value trap there is.'],
  ['Gross margin', 'Revenue minus the direct cost of what was sold, as a % of revenue. High gross margin usually means pricing power — customers can\'t easily go elsewhere.'],
  ['Operating margin', 'Profit from the core business (after running costs, before interest and tax) as a % of revenue. Shows whether the business itself makes money.'],
  ['Profit margin', 'Final net profit as a % of revenue. What\'s left for shareholders after everything.'],
  ['Debt / Equity', 'Total debt divided by shareholder equity. Above ~2 means the company leans heavily on borrowed money — fine in good times, dangerous in bad ones.'],
  ['ROE (return on equity)', 'Profit divided by shareholder equity. How hard the owners\' money is working. Consistently above 15% is strong.'],
  ['Balance sheet', 'The snapshot of what a company owns and owes at one moment in time: assets on one side, liabilities and shareholder equity on the other — and the two sides always balance (assets = liabilities + equity). Unlike an earnings report, which covers a whole quarter or year, the balance sheet is a photograph, not a movie. It answers one question: how sturdy is this company right now?'],
  ['Assets', 'Everything a company owns that has value: cash, inventory, buildings, equipment, patents, and money customers owe it. One side of the balance sheet. The accounting equation ties it together: assets = liabilities + shareholder equity — everything a company owns is claimed by either its lenders or its owners.'],
  ['Liabilities', 'Everything a company owes: loans, bonds, unpaid bills, wages and taxes due. The other side of the balance sheet, across from assets. Paying liabilities down strengthens a company; piling them up is how the debt/equity ratio gets ugly.'],
  ['Shareholder equity', 'What would be left for the owners if the company sold everything it owns and paid off every debt: total assets minus total liabilities. Also called book value. It is the yardstick inside ROE and Debt/Equity — and it is an accounting number, not what the market will pay: market cap is the market\'s (usually much bigger) price tag on that same equity.'],
  ['Free cash flow', 'Cash left after running the business and maintaining it. The hardest number to fake — earnings are an opinion, cash is a fact.'],
  ['Beta', 'How much a stock moves versus the market. Beta 2 = roughly twice the market\'s swings, both ways. High beta + small position size, or hold on tight.'],
  ['Moat', 'A durable advantage that keeps competitors from eating the business — brand, network effects, patents, switching costs. Wide moat = pricing power that lasts.'],
  ['CAGR', 'Compound annual growth rate: the smooth yearly rate that gets you from start to finish. Used for earnings growth assumptions and investment returns.'],
  ['Dividend yield', 'Yearly dividends divided by price. A 3% yield pays you 3% of your money back each year, before any price movement.'],
  ['Analyst target', 'The average price analysts expect within ~12 months. Treat as a sentiment gauge, not a promise — targets chase prices as often as they predict them.'],
  ['TTM (trailing twelve months)', 'The last four reported quarters added together. TTM numbers are actual results, not estimates — but they blend old and new quarters, so they react slowly when a business speeds up or slows down.'],
  ['YoY (year over year)', 'This quarter (or year) compared with the same one a year earlier. The standard way growth is quoted, because it cancels out seasonal patterns like holiday sales.'],
  ['Consensus estimate', 'The average of all analysts\' forecasts for a number like EPS or revenue. It is the bar a company has to clear on earnings day — the stock often moves on whether the report beat or missed this, not on the raw number.'],
  ['Earnings surprise', 'Reported EPS minus the consensus estimate, usually as a %. Positive = a "beat", negative = a "miss". The app\'s miss and beat rates count how often each happened over the last several quarters.'],
  ['Adjusted (non-GAAP) EPS', 'Earnings with one-time items (lawsuits, restructuring, big write-downs) stripped out. This is the EPS analysts estimate and headlines quote. GAAP EPS follows the strict accounting rules and can look very different in a messy quarter.'],
  ['Guidance', 'The company\'s own forecast for the coming quarter or year, given by management. Stocks often move more on guidance than on the results just reported — the market trades the future, not the past.'],
  ['Fiscal year', 'A company\'s own 12-month reporting calendar. It often matches the calendar year, but not always — Walmart\'s fiscal 2026 ends in January 2026, for example. The FY labels in the Projection Builder refer to it.'],
  ['Cyclical', 'A business whose earnings rise and fall with an economic cycle — memory chips, steel, airlines, hotels. Cyclicals look cheapest at peak earnings, which is exactly when they are most dangerous.'],
  ['Value trap', 'A stock that looks cheap (low P/E, big drop from its high) because the business or its earnings are about to get worse. The discount is the market being right, not wrong.'],
  ['Margin of safety', 'The gap between what you pay and what you think a stock is worth. The wider it is, the more wrong you can afford to be. Your value screen hunts for it; it does not guarantee it.'],
  ['SWOT analysis', 'A four-box check of a business. Strengths and Weaknesses are INTERNAL — what the company itself excels at or falls short on: a strong brand, a loyal customer base, a strong balance sheet, unique technology; or high debt, a weak supply chain, a lack of capital. Opportunities and Threats are EXTERNAL — outside factors that could help or harm: a country cutting tariffs opens a new market (opportunity); rising material costs, tougher competition or tight labor supply squeeze the business (threats).'],
  ['Exit P/E (exit multiple)', 'The P/E you assume the market will pay for a stock when you sell it in the future. The Projection Builder multiplies future EPS by this to get the implied price — small changes here swing the answer a lot.'],
  ['Bear / Base / Bull case', 'Three versions of the same forecast: pessimistic, most likely, optimistic. In the Projection Builder they are your EPS path with growth shifted down 5 points, as-is, and up 5 points (plus a small exit P/E adjustment).'],
  ['Implied price', 'The future price a projection works out to: future EPS × exit P/E. It is an "if these assumptions hold" number, not a prediction.'],
  ['Enterprise value', 'Market cap plus total debt minus cash. The cost of buying the whole business outright, debts and all. Better than market cap for comparing companies with very different borrowing.'],
  ['Buyback', 'When a company repurchases its own shares. Fewer shares means each remaining share owns a bigger slice of the profit, so EPS rises even if total profit doesn\'t.'],
  ['Dilution', 'The opposite of a buyback: the company issues more shares (often to pay employees in stock), so each share owns a smaller slice. Profit can grow while EPS shrinks.'],
  ['Drawdown', 'The fall from a peak. A stock 43.6% below its 52-week high is in a 43.6% drawdown from that high — deep enough to be opportunity or warning, which is what the research is for.']
];
function renderGlossary(filter) {
  var f = (filter || '').toLowerCase();
  var html = '';
  GLOSSARY.forEach(function (g) {
    if (f && g[0].toLowerCase().indexOf(f) === -1 && g[1].toLowerCase().indexOf(f) === -1) return;
    html += '<div class="g-item"><div class="g-term">' + esc(g[0]) + '</div><div class="g-def">' + esc(g[1]) + '</div></div>';
  });
  $('gloss-list').innerHTML = html || '<p class="fineprint">No terms match that search.</p>';
}

/* ============================== data backup ============================== */
function collectBackup() {
  return { app: 'stock-research', version: 1, exportedAt: new Date().toISOString(),
           watchlist: getWatchlist(), portfolio: getPortfolio(), journal: getJournal(), aiSwots: lsGet(AI_SWOT_KEY, {}), projections: getProjections() };
}
function doExport() {
  var json = JSON.stringify(collectBackup(), null, 2);
  $('backup-text').value = json;
  var status = $('backup-status');
  status.className = 'status';
  try {
    var blob = new Blob([json], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'stock-research-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    status.textContent = 'Backup downloaded — it is also in the box below, in case you would rather copy it as text.';
  } catch (e) {
    status.textContent = 'Your backup is in the box below — select it and copy it somewhere safe.';
  }
}
function importBackupText(text) {
  var status = $('backup-status');
  var obj;
  try { obj = JSON.parse(String(text || '')); } catch (e) {
    status.className = 'status err'; status.textContent = 'That does not look like a backup (could not read it).'; return;
  }
  var wl = obj && Array.isArray(obj.watchlist) ? obj.watchlist : null;
  var j = obj && obj.journal && typeof obj.journal === 'object' && !Array.isArray(obj.journal) ? obj.journal : null;
  var ai = obj && obj.aiSwots && typeof obj.aiSwots === 'object' && !Array.isArray(obj.aiSwots) ? obj.aiSwots : null;
  var pf = obj && Array.isArray(obj.portfolio) ? obj.portfolio : null;
  var pj = obj && obj.projections && typeof obj.projections === 'object' && !Array.isArray(obj.projections) ? obj.projections : null;
  if (!wl && !j && !ai && !pf && !pj) {
    status.className = 'status err';
    status.textContent = 'That file has no watchlist, portfolio, journal or AI SWOTs in it — not a Stock Research backup.';
    return;
  }
  if (!window.confirm('Replace your current watchlist, portfolio, journal and saved AI SWOTs with this backup?')) return;
  if (wl) setWatchlist(wl);
  if (pj) setProjections(pj);
  if (pf) setPortfolio(pf);
  if (j) setJournal(j);
  if (ai) lsSet(AI_SWOT_KEY, ai);
  renderWatchlist(false);
  renderPortfolio(false);
  renderJournal();
  renderPjSaved();
  if (lastStock) renderScorecard(lastStock);
  status.className = 'status';
  status.textContent = 'Backup restored: ' + (wl ? wl.length : 0) + ' watchlist item(s), ' + (pf ? pf.length : 0) + ' portfolio holding(s), ' + (j ? Object.keys(j).length : 0) + ' journal entr(ies)' + (ai ? ', ' + Object.keys(ai).length + ' AI SWOT(s)' : '') + '.';
}

/* ============================== theme & settings ============================== */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('sr_theme', t); } catch (e) {}
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0d0d0f' : '#ffffff');
  var dBtn = $('theme-dark'), lBtn = $('theme-light');
  if (dBtn && lBtn) {
    dBtn.classList.toggle('active', t === 'dark');
    lBtn.classList.toggle('active', t === 'light');
  }
}

/* ============================== ticker autocomplete ============================== */
/* Suggestion dropdown for ticker inputs: type a company name ("apple",
 * "sofi tech") or a partial ticker and pick the right symbol. Sources:
 * Yahoo symbol search, falling back to Nasdaq's autocomplete — both ride
 * the same relay race as the rest of the app. */
async function tickerSuggestions(q) {
  var query = String(q || '').trim();
  if (query.length < 2) return [];
  try {
    var y = await relayJSON('https://query2.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(query) + '&quotesCount=7&newsCount=0');
    var yq = ((y && y.quotes) || []).filter(function (x) {
      return x && x.symbol && (x.quoteType === 'EQUITY' || x.quoteType === 'ETF');
    }).map(function (x) {
      return { symbol: x.symbol, name: x.longname || x.shortname || '', exch: x.exchDisp || x.exchange || '' };
    });
    if (yq.length) return yq.slice(0, 7);
  } catch (e) {}
  try {
    var n = await relayJSON('https://api.nasdaq.com/api/autocomplete/slookup/10?search=' + encodeURIComponent(query));
    return ((n && n.data) || []).filter(function (x) {
      return x && x.symbol && x.asset === 'STOCKS';
    }).slice(0, 7).map(function (x) {
      return { symbol: x.symbol, name: (x.name || '').replace(/\s+Common Stock$/i, ''), exch: x.exchange || '' };
    });
  } catch (e) {}
  return [];
}
function attachAutocomplete(input, onPick) {
  if (!input) return;
  var list = document.createElement('div');
  list.className = 'ac-list';
  list.style.display = 'none';
  document.body.appendChild(list);
  var seq = 0, timer = null;
  function hide() { list.style.display = 'none'; }
  function place() {
    var r = input.getBoundingClientRect();
    var vv = window.visualViewport;
    var vw = vv ? vv.width : window.innerWidth;
    var vh = vv ? vv.height : window.innerHeight;
    var vL = vv ? vv.offsetLeft : 0;
    var vT = vv ? vv.offsetTop : 0;
    // Wider than narrow inputs so full company names fit, but never
    // wider than the screen and never hanging off either edge.
    var w = Math.min(Math.max(r.width, 270), vw - 16);
    var left = Math.min(Math.max(r.left, vL + 8), vL + vw - w - 8);
    list.style.left = left + 'px';
    list.style.width = w + 'px';
    // Cap the height to the space that is actually visible (an open
    // keyboard shrinks it), open toward whichever side has more room,
    // and clamp the result inside the viewport: the options can never
    // run off the top or bottom of the screen again. Extra options
    // scroll inside the list.
    var below = (vT + vh) - r.bottom - 10;
    var above = r.top - vT - 10;
    var openUp = below < 200 && above > below;
    list.style.maxHeight = Math.max(90, Math.min(302, openUp ? above : below)) + 'px';
    var wasHidden = list.style.display === 'none';
    if (wasHidden) { list.style.visibility = 'hidden'; list.style.display = 'block'; }
    var h = list.offsetHeight;
    var top = openUp ? r.top - 4 - h : r.bottom + 4;
    var lo = vT + 6, hi = vT + vh - h - 6;
    var tbEl = document.querySelector('.topbar');
    if (tbEl) lo = Math.max(lo, tbEl.getBoundingClientRect().bottom + 4);
    if (hi < lo) hi = lo;
    list.style.top = Math.min(Math.max(top, lo), hi) + 'px';
    if (wasHidden) { list.style.display = 'none'; list.style.visibility = ''; }
  }
  function show(items) {
    if (!items.length) { hide(); return; }
    list.innerHTML = items.map(function (it) {
      return '<button type="button" class="ac-item" data-sym="' + esc(it.symbol) + '">' +
        '<span class="ac-top"><span class="ac-sym">' + esc(it.symbol) + '</span>' +
        (it.exch ? '<span class="ac-exch">' + esc(it.exch) + '</span>' : '') + '</span>' +
        '<span class="ac-name">' + esc(it.name) + '</span></button>';
    }).join('');
    place();
    list.style.display = 'block';
    list.querySelectorAll('.ac-item').forEach(function (b) {
      b.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        var sym = b.getAttribute('data-sym');
        input.value = sym;
        hide();
        input.blur();
        if (onPick) onPick(sym);
      });
    });
  }
  input.addEventListener('input', function () {
    var q = input.value;
    var my = ++seq;
    if (timer) clearTimeout(timer);
    if (String(q).trim().length < 2) { hide(); return; }
    timer = setTimeout(async function () {
      var items = await tickerSuggestions(q);
      if (my !== seq) return;
      show(items);
    }, 220);
  });
  input.addEventListener('focus', function () {
    // Inputs low on the screen (Quarterly Metrics sits below the
    // Projection Builder) used to get a dropdown flipped up over the
    // header; the other inputs all sit high and open downward. Bring
    // a low input up to the same zone on focus so its list opens
    // downward, attached, like everywhere else.
    setTimeout(function () {
      var r = input.getBoundingClientRect();
      var vv = window.visualViewport;
      var vh = vv ? vv.height : window.innerHeight;
      var vT = vv ? vv.offsetTop : 0;
      if (r.top <= vT + vh * 0.45) return;
      var main = document.querySelector('main');
      var tb = document.querySelector('.topbar');
      var headB = tb ? tb.getBoundingClientRect().bottom : vT + 56;
      if (main) main.scrollTop += r.top - headB - 14;
    }, 350);
  });
  input.addEventListener('blur', function () { setTimeout(hide, 180); });
  input.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
  window.addEventListener('resize', function () { if (list.style.display !== 'none') place(); });
  var mainEl = document.querySelector('main');
  if (mainEl) mainEl.addEventListener('scroll', function () { if (list.style.display !== 'none') place(); }, { passive: true });
}

/* ============================== tabs & init ============================== */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function (s) { s.classList.toggle('active', s.id === 'tab-' + name); });
  document.querySelectorAll('.tabbar button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === name); });
  var mn = document.querySelector('main');
  if (mn) mn.scrollTop = 0;
}
/* iOS standalone quirk: 100dvh intermittently resolves SHORT at
 * launch/resume, leaving the tab bar floating above a dead black
 * strip (Justin, 2026-10-26). Pin the shell height to the measured
 * inner height and re-measure on every lifecycle event that can
 * change it. Keyboard-safe: innerHeight ignores the keyboard. */
function fitShell() {
  try {
    var h = window.innerHeight || 0;
    // iOS standalone reports a SHORT innerHeight after an in-app
    // reload (it never re-fires resize), so trust the physical
    // screen height when running from the home screen in portrait:
    // the shell is supposed to fill exactly that.
    var standalone = (window.navigator && window.navigator.standalone) ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (standalone && window.screen && window.screen.height && window.innerHeight >= window.innerWidth) {
      h = Math.max(h, window.screen.height);
    }
    if (h > 0) document.documentElement.style.setProperty('--app-h', h + 'px');
  } catch (e) {}
}
window.addEventListener('resize', fitShell);
window.addEventListener('orientationchange', fitShell);
window.addEventListener('pageshow', fitShell);
window.addEventListener('load', fitShell);
window.addEventListener('focus', fitShell);
document.addEventListener('visibilitychange', function () { if (!document.hidden) fitShell(); });
fitShell();
setTimeout(fitShell, 300);
setTimeout(fitShell, 1200);
setTimeout(fitShell, 2500);

function initApp() {
  document.querySelectorAll('.tabbar button').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
  });
  $('search-form').addEventListener('submit', function (e) {
    e.preventDefault();
    runSearch($('search-input').value);
    $('search-input').blur();
  });
  attachAutocomplete($('search-input'), function (sym) { runSearch(sym); });
  attachAutocomplete($('pj-ticker'), function () { loadProjectionTicker(); });
  attachAutocomplete($('wl-ticker'), null);
  attachAutocomplete($('cmp-1'), null);
  attachAutocomplete($('cmp-2'), null);
  attachAutocomplete($('cmp-3'), null);
  attachAutocomplete($('j-ticker'), null);
  attachAutocomplete($('pf-ticker'), null);
  var pfAddBody = $('pf-add-body');
  function pfSetForm(open) {
    pfAddBody.hidden = !open;
    document.querySelector('.pf-add-card').classList.toggle('open', open);
    $('pf-add-toggle').setAttribute('aria-expanded', String(open));
  }
  $('pf-add-toggle').addEventListener('click', function () { pfSetForm(pfAddBody.hidden); });
  $('pf-view-overview').addEventListener('click', function () { pfSetView('overview'); });
  $('pf-view-news').addEventListener('click', function () { pfSetView('news'); });
  pfSetView(pfView());
  if (!getPortfolio().length) pfSetForm(true);
  $('pf-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var T = ($('pf-ticker').value || '').trim().toUpperCase();
    var shares = parseFloat($('pf-shares').value);
    var status = $('pf-status');
    if (!T) { status.className = 'status err'; status.textContent = 'Enter a ticker first.'; return; }
    if (!isNum(shares) || shares < 0) { status.className = 'status err'; status.textContent = 'Enter how many shares you own (0 for a stock you already sold).'; return; }
    var cost = parseFloat($('pf-cost').value);
    var pf = getPortfolio().filter(function (x) { return x.ticker !== T; });
    pf.push({ ticker: T, shares: shares, drip: $('pf-drip').value === 'yes', cost: isNum(cost) && cost > 0 ? cost : null, addedAt: Date.now() });
    setPortfolio(pf);
    $('pf-ticker').value = ''; $('pf-shares').value = ''; $('pf-cost').value = '';
    status.className = 'status'; status.textContent = '';
    pfSetForm(false);
    renderPortfolio(true);
  });
  $('pf-refresh').addEventListener('click', function () { renderPortfolio(true); });
  var pfBtn = document.querySelector('.tabbar button[data-tab="portfolio"]');
  if (pfBtn) pfBtn.addEventListener('click', function () { renderPortfolio(!pfFetchedOnce); });
  renderPortfolio(false);
  $('compare-form').addEventListener('submit', function (e) { e.preventDefault(); runCompare(); });
  $('pj-run').addEventListener('click', runProjection);
  $('pj-path').addEventListener('change', onPjPathEdit);
  $('pj-years').addEventListener('change', function () { renderPjPath(); });
  $('pj-growth').addEventListener('change', function () { if (!pjPathFromForecast) pjSynthPath(); renderPjPath(); });
  $('pj-eps').addEventListener('change', function () { if (!pjPathFromForecast) pjSynthPath(); renderPjPath(); });
  renderPjPath();
  $('pj-load-form').addEventListener('submit', function (e) {
    e.preventDefault();
    loadProjectionTicker();
    $('pj-ticker').blur();
  });
  $('cc-run').addEventListener('click', runCompound);
  runCompound();
  attachAutocomplete($('qm-ticker'), function (sym) { $('qm-ticker').value = sym; loadQm(); });
  $('qm-load-form').addEventListener('submit', function (e) { e.preventDefault(); loadQm(); $('qm-ticker').blur(); });
  document.querySelectorAll('[data-qm]').forEach(function (b) {
    b.addEventListener('click', function () { qmMetric = b.getAttribute('data-qm'); renderQm(); });
  });
  try { qmFreq = lsGet('sr_qmfreq', 'q') === 'y' ? 'y' : 'q'; } catch (e) {}
  document.querySelectorAll('[data-qmfreq]').forEach(function (b) {
    b.addEventListener('click', function () {
      qmFreq = b.getAttribute('data-qmfreq');
      lsSet('sr_qmfreq', qmFreq);
      if (qmStore.ticker) loadQm();
    });
  });
  $('wl-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var t = $('wl-ticker').value, target = parseFloat($('wl-target').value);
    if (!t.trim()) return;
    addToWatchlist(t, isNum(target) ? target : null);
    $('wl-ticker').value = ''; $('wl-target').value = '';
  });
  $('wl-refresh').addEventListener('click', function () { renderWatchlist(true); });
  maybeStartScan();
  var wlSortSel = $('wl-sort');
  if (wlSortSel) {
    wlSortSel.value = getWlSort();
    wlSortSel.addEventListener('change', function () {
      try { localStorage.setItem(WLSORT_KEY, wlSortSel.value); } catch (e) {}
      renderWatchlist(false);
    });
  }
  $('btn-export').addEventListener('click', doExport);
  $('btn-import').addEventListener('click', function () { $('import-file').click(); });
  $('import-file').addEventListener('change', function () {
    var f = $('import-file').files && $('import-file').files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () { importBackupText(String(r.result || '')); };
    r.readAsText(f);
    $('import-file').value = '';
  });
  $('btn-import-text').addEventListener('click', function () { importBackupText($('backup-text').value); });
  // Settings menu + theme (dark is the default).
  var savedTheme = null;
  try { savedTheme = localStorage.getItem('sr_theme'); } catch (e) {}
  applyTheme(savedTheme === 'light' ? 'light' : 'dark');
  $('theme-dark').addEventListener('click', function () { applyTheme('dark'); });
  $('theme-light').addEventListener('click', function () { applyTheme('light'); });
  var settingsMenu = $('settings-menu');
  $('menu-glossary').addEventListener('click', function () {
    settingsMenu.hidden = true;
    $('btn-settings').setAttribute('aria-expanded', 'false');
    switchTab('glossary');
  });
  $('menu-journal').addEventListener('click', function () {
    settingsMenu.hidden = true;
    $('btn-settings').setAttribute('aria-expanded', 'false');
    switchTab('journal');
  });
  $('btn-settings').addEventListener('click', function (e) {
    e.stopPropagation();
    var willOpen = settingsMenu.hidden;
    settingsMenu.hidden = !willOpen;
    $('btn-settings').setAttribute('aria-expanded', String(willOpen));
  });
  document.addEventListener('click', function (e) {
    if (!settingsMenu.hidden && !settingsMenu.contains(e.target)) {
      settingsMenu.hidden = true;
      $('btn-settings').setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      settingsMenu.hidden = true;
      $('btn-settings').setAttribute('aria-expanded', 'false');
    }
  });
  $('set-clear-ai').addEventListener('click', function () {
    try { localStorage.removeItem(AI_SWOT_KEY); } catch (e) {}
    $('settings-note').textContent = 'Saved AI SWOTs cleared — regenerate any of them from a scorecard.';
    if (lastStock) renderScorecard(lastStock);
  });
  $('set-clear-cache').addEventListener('click', function () {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
    $('settings-note').textContent = 'Price cache cleared — the next lookups fetch fresh data.';
  });
  $('set-reload').addEventListener('click', function () { location.reload(); });
  $('journal-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var T = ($('j-ticker').value || '').trim().toUpperCase();
    if (!T) return;
    var j = getJournal();
    j[T] = {
      thesis: $('j-thesis').value.trim(), catalysts: $('j-catalysts').value.trim(),
      bull: $('j-bull').value.trim(), base: $('j-base').value.trim(), bear: $('j-bear').value.trim(),
      review: $('j-review').value || '', updatedAt: Date.now()
    };
    setJournal(j);
    resetJournalForm();
    renderJournal();
  });
  $('j-cancel').addEventListener('click', resetJournalForm);
  $('gloss-search').addEventListener('input', function (e) { renderGlossary(e.target.value); });
  renderGlossary('');
  renderJournal();
  renderPjSaved();
  renderWatchlist(true);
}
if (typeof document !== 'undefined' && document.getElementById) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
  else initApp();
}
/* ==================== Supabase cloud sync (TEST COPY) ====================
 * Added only in ~/workspace/stock-research-supabase-test/ — the live app
 * does not have this section.
 *
 * Contract:
 *  - Config lives in supabase-config.js (window.SR_SUPABASE_URL /
 *    window.SR_SUPABASE_ANON_KEY). If either is empty, this whole block
 *    returns without touching the UI, localStorage, or the network, so
 *    the app behaves EXACTLY as the live version.
 *  - localStorage is always the source of truth. Every Supabase call is
 *    wrapped so a down/slow/misconfigured backend can only ever produce
 *    a status line — never an app error.
 *  - Only personal, irreplaceable data syncs (see SR_SYNC_DEFS). Price,
 *    scan and chart caches are regenerable and are NEVER synced.
 *
 * Data formats (matching how the app itself stores each key):
 *  - kind 'json'   — the app stores JSON.stringify(value) (via lsSet);
 *                    the parsed value is stored in Supabase as jsonb.
 *  - kind 'string' — the app stores a raw string (direct setItem);
 *                    the string is stored in Supabase as a JSON string
 *                    and written back raw, never JSON-quoted.
 *
 * Sign-in reconciliation (v1, deliberately conservative):
 *  - remote has data + local is empty/default  -> pull remote into local
 *  - local has data + remote is empty          -> push local up
 *  - both have data                             -> keep BOTH untouched
 *    (no silent overwrite in either direction; from then on, any new
 *    local change debounce-pushes and becomes the cloud copy)
 *  - a synced key removed locally deletes its cloud row.
 */
(function srSupabaseSync() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (typeof localStorage === 'undefined') return;

  var SR_SYNC_DEFS = [
    { key: 'sr_watchlist_v1', kind: 'json' },
    { key: 'sr_portfolio_v1', kind: 'json' },
    { key: 'sr_journal_v1', kind: 'json' },
    { key: 'sr_projections_v1', kind: 'json' },
    { key: 'sr_aiswot_v1', kind: 'json' },
    { key: 'sr_theme', kind: 'string' },
    { key: 'sr_wlsort_v1', kind: 'string' },
    { key: 'sr_pfview_v1', kind: 'string' }
  ];
  var SR_SYNC_BY_KEY = {};
  SR_SYNC_DEFS.forEach(function (d) { SR_SYNC_BY_KEY[d.key] = d; });

  var url = String(window.SR_SUPABASE_URL || '').trim();
  var anonKey = String(window.SR_SUPABASE_ANON_KEY || '').trim();
  if (!url || !anonKey) return; // not configured: behave exactly as today

  var client = null;
  try {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      throw new Error('Supabase library did not load');
    }
    client = window.supabase.createClient(url, anonKey);
  } catch (e) {
    client = null;
  }

  var section = document.getElementById('sync-section');
  if (section) section.hidden = false;

  var currentUser = null;
  var patchInstalled = false;
  var applyingRemote = false;
  var pushTimers = {};

  function setSyncStatus(msg, isErr) {
    try {
      var el = document.getElementById('sync-status');
      if (!el) return;
      el.className = 'status' + (isErr ? ' err' : '');
      el.textContent = msg || '';
    } catch (e) {}
  }

  function isEmptyParsed(v) {
    if (v == null || v === '') return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  }

  function readLocal(def) {
    var raw = null;
    try { raw = localStorage.getItem(def.key); } catch (e) {}
    if (raw == null || raw === '') return { present: false, empty: true, value: null };
    if (def.kind === 'string') return { present: true, empty: false, value: raw };
    try {
      var parsed = JSON.parse(raw);
      return { present: true, empty: isEmptyParsed(parsed), value: parsed };
    } catch (e) {
      return { present: true, empty: false, value: raw };
    }
  }

  function writeLocal(def, remoteValue) {
    applyingRemote = true;
    try {
      if (def.kind === 'string') localStorage.setItem(def.key, String(remoteValue));
      else localStorage.setItem(def.key, JSON.stringify(remoteValue));
    } catch (e) {} finally { applyingRemote = false; }
  }

  function refreshAfterPull() {
    applyingRemote = true;
    try {
      try {
        var t = localStorage.getItem('sr_theme');
        if ((t === 'light' || t === 'dark') && typeof applyTheme === 'function') applyTheme(t);
      } catch (e) {}
      try {
        var sortSel = document.getElementById('wl-sort');
        if (sortSel && typeof getWlSort === 'function') sortSel.value = getWlSort();
      } catch (e) {}
      try { if (typeof pfSetView === 'function' && typeof pfView === 'function') pfSetView(pfView()); } catch (e) {}
      try { if (typeof renderWatchlist === 'function') renderWatchlist(false); } catch (e) {}
      try { if (typeof renderPortfolio === 'function') renderPortfolio(false); } catch (e) {}
      try { if (typeof renderJournal === 'function') renderJournal(); } catch (e) {}
      try { if (typeof renderPjSaved === 'function') renderPjSaved(); } catch (e) {}
      try {
        if (typeof lastStock !== 'undefined' && lastStock && typeof renderScorecard === 'function') {
          renderScorecard(lastStock);
        }
      } catch (e) {}
    } finally { applyingRemote = false; }
  }

  async function pushKey(key) {
    if (!client || !currentUser) return;
    var def = SR_SYNC_BY_KEY[key];
    if (!def) return;
    try {
      var local = readLocal(def);
      var res;
      if (!local.present) {
        res = await client.from('user_data').delete()
          .eq('user_id', currentUser.id).eq('data_key', key);
      } else {
        res = await client.from('user_data').upsert({
          user_id: currentUser.id,
          data_key: key,
          value: local.value,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,data_key' });
      }
      if (res && res.error) throw res.error;
      setSyncStatus('Synced just now.');
    } catch (e) {
      setSyncStatus('Sync failed — changes are safe on this device and will retry on the next change.', true);
    }
  }

  function schedulePush(key) {
    if (!currentUser || applyingRemote) return;
    if (!SR_SYNC_BY_KEY[key]) return;
    if (pushTimers[key]) clearTimeout(pushTimers[key]);
    pushTimers[key] = setTimeout(function () {
      delete pushTimers[key];
      pushKey(key);
    }, 2000);
  }

  function installWritePatch() {
    if (patchInstalled) return;
    patchInstalled = true;
    try {
      var origSet = Storage.prototype.setItem;
      var origRemove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (k, v) {
        var out = origSet.call(this, k, v);
        try { if (this === localStorage) schedulePush(String(k)); } catch (e) {}
        return out;
      };
      Storage.prototype.removeItem = function (k) {
        var out = origRemove.call(this, k);
        try { if (this === localStorage) schedulePush(String(k)); } catch (e) {}
        return out;
      };
    } catch (e) {
      /* If the prototype cannot be patched on this browser, sign-in
       * reconciliation above still works; only live push is lost. */
    }
  }

  async function reconcile() {
    if (!client || !currentUser) return;
    setSyncStatus('Checking your cloud backup…');
    try {
      var res = await client.from('user_data')
        .select('data_key, value')
        .eq('user_id', currentUser.id);
      if (res && res.error) throw res.error;
      var remote = {};
      ((res && res.data) || []).forEach(function (row) { remote[row.data_key] = row.value; });

      var pulled = [], pushKeys = [], both = 0;
      SR_SYNC_DEFS.forEach(function (def) {
        var hasRemote = Object.prototype.hasOwnProperty.call(remote, def.key) &&
          remote[def.key] != null && !isEmptyParsed(remote[def.key]);
        var local = readLocal(def);
        if (hasRemote && local.empty) {
          writeLocal(def, remote[def.key]);
          pulled.push(def.key);
        } else if (!local.empty && !hasRemote) {
          pushKeys.push(def.key);
        } else if (!local.empty && hasRemote) {
          both++;
        }
      });
      for (var i = 0; i < pushKeys.length; i++) await pushKey(pushKeys[i]);
      if (pulled.length) refreshAfterPull();
      if (pulled.length || pushKeys.length) {
        setSyncStatus('Sync done — ' +
          (pulled.length ? pulled.length + ' item(s) restored from the cloud. ' : '') +
          (pushKeys.length ? pushKeys.length + ' item(s) backed up. ' : '') +
          (both ? both + ' item(s) exist in both places — kept this device\u2019s copy.' : ''));
      } else if (both) {
        setSyncStatus('Signed in. Your data here and in the cloud both exist — kept this device\u2019s copy; new changes sync from now on.');
      } else {
        setSyncStatus('Signed in. Nothing to sync yet — add something and it backs up automatically.');
      }
    } catch (e) {
      setSyncStatus('Could not reach Supabase — the app keeps working from this device.', true);
    }
  }

  function showAuthState() {
    try {
      var out = document.getElementById('sync-signed-out');
      var inn = document.getElementById('sync-signed-in');
      var userEl = document.getElementById('sync-user');
      if (currentUser) {
        if (out) out.hidden = true;
        if (inn) inn.hidden = false;
        if (userEl) userEl.textContent = currentUser.email || '';
      } else {
        if (out) out.hidden = false;
        if (inn) inn.hidden = true;
        if (userEl) userEl.textContent = '';
      }
    } catch (e) {}
  }

  async function afterSignIn(user) {
    currentUser = user || null;
    showAuthState();
    if (!currentUser) return;
    installWritePatch();
    await reconcile();
  }

  function wireSyncUi() {
    var signInBtn = document.getElementById('sync-signin');
    var signUpBtn = document.getElementById('sync-signup');
    var signOutBtn = document.getElementById('sync-signout');
    var syncNowBtn = document.getElementById('sync-now');
    function creds() {
      var em = document.getElementById('sync-email');
      var pw = document.getElementById('sync-password');
      return {
        email: em ? String(em.value || '').trim() : '',
        password: pw ? String(pw.value || '') : ''
      };
    }
    if (signInBtn) signInBtn.addEventListener('click', async function () {
      if (!client) { setSyncStatus('Sync is unavailable right now — the app still works offline.', true); return; }
      var c = creds();
      if (!c.email || !c.password) { setSyncStatus('Enter your email and password first.', true); return; }
      setSyncStatus('Signing in…');
      try {
        var r = await client.auth.signInWithPassword(c);
        if (r.error) throw r.error;
        await afterSignIn(r.data && r.data.user);
      } catch (e) {
        setSyncStatus('Sign-in failed: ' + (e && e.message ? e.message : 'unknown error'), true);
      }
    });
    if (signUpBtn) signUpBtn.addEventListener('click', async function () {
      if (!client) { setSyncStatus('Sync is unavailable right now — the app still works offline.', true); return; }
      var c = creds();
      if (!c.email || !c.password) { setSyncStatus('Enter an email and a password first.', true); return; }
      setSyncStatus('Creating your account…');
      try {
        var r = await client.auth.signUp(c);
        if (r.error) throw r.error;
        if (r.data && r.data.session && r.data.user) {
          await afterSignIn(r.data.user);
        } else {
          setSyncStatus('Account created — confirm it from the email Supabase sent you, then sign in.');
        }
      } catch (e) {
        setSyncStatus('Sign-up failed: ' + (e && e.message ? e.message : 'unknown error'), true);
      }
    });
    if (signOutBtn) signOutBtn.addEventListener('click', async function () {
      try { if (client) await client.auth.signOut(); } catch (e) {}
      currentUser = null;
      showAuthState();
      setSyncStatus('Signed out — your data stays on this device.');
    });
    if (syncNowBtn) syncNowBtn.addEventListener('click', function () { reconcile(); });
    window.addEventListener('online', function () { if (currentUser) reconcile(); });
  }

  try {
    wireSyncUi();
    if (!client) {
      setSyncStatus('Sync is unavailable (library or connection problem) — the app still works from this device.', true);
      return;
    }
    showAuthState();
    setSyncStatus('Not signed in.');
    client.auth.getSession().then(function (r) {
      var session = r && r.data && r.data.session;
      if (session && session.user) return afterSignIn(session.user);
      return null;
    }).catch(function () {
      setSyncStatus('Could not reach Supabase — the app keeps working from this device.', true);
    });
    try {
      client.auth.onAuthStateChange(function (event) {
        if (event === 'SIGNED_OUT') {
          currentUser = null;
          showAuthState();
        }
      });
    } catch (e) {}
  } catch (e) {
    try { setSyncStatus('Sync failed to start — the app still works from this device.', true); } catch (e2) {}
  }
})();

/* Node export for offline pipeline tests (ignored in the browser). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseFinviz: parseFinviz, scoreStock: scoreStock, valueScreen: valueScreen, epsTrajectory: epsTrajectory, parseNum: parseNum, parseCapStr: parseCapStr, fetchStock: fetchStock, relayFetch: relayFetch, relayJSON: relayJSON, fillProjection: fillProjection, pjGrowths: pjGrowths, pjCaseEps: pjCaseEps, parseMBEarnings: parseMBEarnings, epsRecordStats: epsRecordStats, parseRevStr: parseRevStr, buildSwot: buildSwot, tickerSuggestions: tickerSuggestions, pjFadeGrowth: pjFadeGrowth, pfPaletteColors: pfPaletteColors, parseSAPeHistory: parseSAPeHistory, fetchPe5yAvg: fetchPe5yAvg };
}
