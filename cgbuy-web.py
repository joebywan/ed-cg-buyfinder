#!/usr/bin/env python3
"""
cgbuy - buy-location finder for the Ega / Metz Enterprise community goal.

Single-file, stdlib-only. Run it and a UI opens in your browser:

    ./cgbuy                 # serve the UI
    ./cgbuy --port 8800     # pick the port
    ./cgbuy --no-browser    # don't auto-open

Live sell prices come from EDSM, buy prices and supply from Spansh.
"""

import argparse
import http.server
import json
import math
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor

CG_STATION = "Metz Enterprise"
CG_SYSTEM = "Ega"
COMMODITIES = [
    "Palladium", "Gold", "Silver", "Bertrandite", "Indite", "Gallite",
    "Coltan", "Uraninite", "Lepidolite", "Cobalt", "Rutile", "Water",
]

SPANSH_SEARCH = "https://spansh.co.uk/api/stations/search"
EDSM_MARKET = ("https://www.edsm.net/api-system-v1/stations/market"
               "?systemName={sys}&stationName={stn}")
EDSM_STATIONS = "https://www.edsm.net/api-system-v1/stations?systemName={sys}"
AGENT = "cgbuy/2.0 (personal ED trade helper)"


# --------------------------------------------------------------------------
# data layer
# --------------------------------------------------------------------------

def post_json(url, payload, timeout=60):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"User-Agent": AGENT, "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def get_json(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_cg_prices():
    """Sell prices at the CG station. The CG's price multiplier is already
    baked into these, so we never apply it ourselves."""
    url = EDSM_MARKET.format(sys=urllib.parse.quote(CG_SYSTEM),
                             stn=urllib.parse.quote(CG_STATION))
    data = get_json(url)
    return {c["name"]: {"sell": c["sellPrice"], "demand": c["demand"]}
            for c in data.get("commodities", []) if c["name"] in COMMODITIES}


def fetch_cg_arrival_ls():
    try:
        d = get_json(EDSM_STATIONS.format(sys=urllib.parse.quote(CG_SYSTEM)))
        for s in d.get("stations", []):
            if s["name"] == CG_STATION:
                return s.get("distanceToArrival", 0) or 0
    except Exception:
        pass
    return 0


def fetch_sources(commodity, max_ly, min_supply, page_size=500, max_pages=10):
    """Every market within max_ly that stocks `commodity`.

    Spansh caps results per request, so page through until we run past the
    radius. A single fixed page silently drops most candidates.
    """
    out = []
    for page in range(max_pages):
        payload = {
            "filters": {
                "distance": {"comparison": "<=>", "value": [0, max_ly]},
                "market": [{
                    "name": commodity,
                    "supply": {"comparison": "<=>",
                               "value": [min_supply, 100000000]},
                }],
            },
            "sort": [{"distance": {"direction": "asc"}}],
            "size": page_size, "page": page, "reference_system": CG_SYSTEM,
        }
        try:
            res = post_json(SPANSH_SEARCH, payload).get("results", [])
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
            break
        out.extend(res)
        if len(res) < page_size or res[-1].get("distance", 0) > max_ly:
            break
    return out


def sc_minutes(ls):
    """Rough supercruise time from the arrival star, in minutes.
    Fitted by eye: ~1 min at 100 Ls, ~4 min at 10k Ls, ~8 min at 100k Ls."""
    return 0.25 * max(ls, 1) ** 0.3


def trip_minutes(dist_ly, src_ls, cg_ls, jump_empty, jump_laden):
    out_j = math.ceil(dist_ly / jump_empty) if dist_ly > 0 else 0
    back_j = math.ceil(dist_ly / jump_laden) if dist_ly > 0 else 0
    jumps = (out_j + back_j) * 0.85            # align + charge + scoop
    cruise = sc_minutes(src_ls) * 2 + sc_minutes(cg_ls) * 2
    return max(jumps + cruise + 6.0, 0.5)      # 6 min = dock/trade/undock x2


def build_rows(p, progress=None):
    """Fetch everything and score it. `p` is the parameter dict from the UI."""
    cg = fetch_cg_prices()
    if not cg:
        raise RuntimeError("EDSM returned no market for %s - station renamed?"
                           % CG_STATION)
    cg_ls = fetch_cg_arrival_ls()
    rows, done, lock = [], 0, threading.Lock()

    def one(name):
        nonlocal done
        info = cg.get(name)
        local = []
        if info and info["sell"] > 0:
            sell = info["sell"]
            for st in fetch_sources(name, p["range"], p["min_supply"]):
                if not st.get("has_large_pad"):
                    continue
                carrier = "Carrier" in str(st.get("type", ""))
                if carrier and not p["carriers"]:
                    continue
                e = next((c for c in st.get("market", [])
                          if c["commodity"] == name), None)
                if not e or e["supply"] <= 0 or e["buy_price"] <= 0:
                    continue
                dist = st.get("distance", 0.0)
                if dist > p["range"]:
                    continue
                profit = sell - e["buy_price"]
                if profit <= 0:
                    continue
                src_ls = st.get("distance_to_arrival", 0) or 0
                mins = trip_minutes(dist, src_ls, cg_ls,
                                    p["jump_empty"], p["jump_laden"])
                load = min(e["supply"], p["hold"])
                local.append({
                    "commodity": name, "station": st.get("name", "?"),
                    "system": st.get("system_name", "?"), "carrier": carrier,
                    "ly": round(dist, 1), "ls": round(src_ls),
                    "supply": e["supply"], "buy": e["buy_price"], "sell": sell,
                    "profit_per_t": profit, "load": load,
                    "loads_available": round(e["supply"] / p["hold"], 1),
                    "trip_minutes": round(mins, 1),
                    "trip_profit": load * profit,
                    "cr_per_min": round(load * profit / mins),
                    "t_per_min": round(load / mins, 1),
                    "updated": (st.get("market_updated_at") or "")[:10],
                })
        with lock:
            rows.extend(local)
            done += 1
            if progress:
                progress(done, len(COMMODITIES), name)

    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(one, COMMODITIES))

    return rows, cg, cg_ls


def build_mixed(rows, hold):
    """Rank stations by the best hold they can actually fill.

    A station's most profitable commodity is often supply-capped well below
    your hold. Topping up with that same station's next best costs no extra
    travel, and is typically worth ~20% more per run.
    """
    stations = {}
    for r in rows:
        stations.setdefault((r["station"], r["system"]), []).append(r)

    plans = []
    for (stn, sysn), items in stations.items():
        items.sort(key=lambda r: -r["profit_per_t"])
        remaining, total, mix = hold, 0, []
        for it in items:
            if remaining <= 0:
                break
            take = min(it["supply"], remaining)
            if take <= 0:
                continue
            mix.append({"commodity": it["commodity"], "tonnes": take,
                        "profit_per_t": it["profit_per_t"],
                        "buy": it["buy"], "value": take * it["profit_per_t"]})
            total += take * it["profit_per_t"]
            remaining -= take
        if not mix:
            continue
        mins = items[0]["trip_minutes"]
        plans.append({
            "station": stn, "system": sysn, "ly": items[0]["ly"],
            "ls": items[0]["ls"], "carrier": items[0]["carrier"],
            "updated": items[0]["updated"], "tonnes": hold - remaining,
            "short": remaining, "trip_minutes": mins, "total": total,
            "cr_per_min": round(total / mins), "mix": mix,
        })
    plans.sort(key=lambda x: -x["cr_per_min"])
    return plans


# --------------------------------------------------------------------------
# job state
# --------------------------------------------------------------------------

JOB = {"running": False, "done": 0, "total": len(COMMODITIES),
       "current": "", "error": None, "payload": None, "started": 0}
JOB_LOCK = threading.Lock()


def run_job(params):
    def progress(done, total, name):
        with JOB_LOCK:
            JOB["done"], JOB["total"], JOB["current"] = done, total, name

    with JOB_LOCK:
        JOB.update(running=True, done=0, current="starting",
                   error=None, payload=None, started=time.time())
    try:
        rows, cg, cg_ls = build_rows(params, progress)
        rows.sort(key=lambda r: -r["cr_per_min"])
        payload = {
            "rows": rows,
            "mixed": build_mixed(rows, params["hold"]),
            "cg_prices": cg, "cg_ls": cg_ls,
            "cg_station": CG_STATION, "cg_system": CG_SYSTEM,
            "params": params,
            "elapsed": round(time.time() - JOB["started"], 1),
        }
        with JOB_LOCK:
            JOB["payload"] = payload
    except Exception as e:
        with JOB_LOCK:
            JOB["error"] = f"{type(e).__name__}: {e}"
    finally:
        with JOB_LOCK:
            JOB["running"] = False


# --------------------------------------------------------------------------
# UI
# --------------------------------------------------------------------------

HTML = r"""<!doctype html>
<html><head><meta charset="utf-8"><title>CG Buy Finder - Ega</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{
  --bg:#0b0a09; --panel:#151210; --line:#3a2c1d; --line2:#241b13;
  --or:#ff7100; --or-dim:#b35400; --txt:#f0c9a0; --txt-dim:#9c7a55;
  --good:#5ec27a; --warn:#e0a33a; --bad:#d05a4a;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:#e8c9a6;
  font:13px/1.45 "DejaVu Sans Mono",Menlo,Consolas,monospace}
a{color:var(--or)}
header{padding:14px 20px;border-bottom:1px solid var(--line);
  background:linear-gradient(180deg,#1a1410,#0b0a09);
  display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}
h1{margin:0;font-size:15px;letter-spacing:2.5px;color:var(--or);font-weight:600}
.sub{color:#a8825c;font-size:12px}
main{padding:18px 20px;max-width:1700px}
.panel{background:var(--panel);border:1px solid var(--line2);
  border-radius:3px;padding:14px 16px;margin-bottom:16px}
.ctl{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end}
label{display:block;font-size:10px;letter-spacing:1.4px;color:#8a6a49;
  text-transform:uppercase;margin-bottom:4px}
input[type=number]{width:92px}
input[type=number],select{background:#0a0908;color:var(--txt);
  border:1px solid var(--line);border-radius:2px;padding:6px 8px;
  font:12px "DejaVu Sans Mono",monospace}
input:focus,select:focus{outline:none;border-color:var(--or)}
.chk{display:flex;align-items:center;gap:7px;padding-bottom:7px;cursor:pointer}
.chk input{accent-color:var(--or);width:15px;height:15px;cursor:pointer}
.chk span{font-size:11px;letter-spacing:.6px;color:#b9976f}
button{background:var(--or);color:#140c05;border:0;border-radius:2px;
  padding:9px 22px;font:600 12px/1 "DejaVu Sans Mono",monospace;
  letter-spacing:1.6px;cursor:pointer;text-transform:uppercase}
button:hover{background:#ff8a2e}
button:disabled{background:#4a3a2a;color:#8a7256;cursor:not-allowed}
.tabs{display:flex;gap:2px;margin-bottom:14px}
.tab{padding:8px 20px;background:#141110;border:1px solid var(--line2);
  border-bottom:none;color:#9a7c5a;cursor:pointer;font-size:11px;
  letter-spacing:1.5px;text-transform:uppercase}
.tab.on{background:var(--panel);color:var(--or);border-color:var(--line);
  box-shadow:inset 0 2px 0 var(--or)}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:right;padding:7px 9px;font-size:10px;letter-spacing:1.1px;
  color:#8a6a49;border-bottom:1px solid var(--line);cursor:pointer;
  white-space:nowrap;text-transform:uppercase;user-select:none}
th:hover{color:var(--or)}
th.l,td.l{text-align:left}
th.arrow::after{content:" \25BC";color:var(--or)}
th.arrow.up::after{content:" \25B2"}
td{padding:6px 9px;text-align:right;border-bottom:1px solid #191410;
  white-space:nowrap}
tbody tr:hover{background:#1d1611}
tbody tr:nth-child(1) td{background:#231a10}
.cm{color:var(--or);font-weight:600}
.big{color:#ffd9a8;font-weight:600}
.muted{color:#7d6144}
.fc{color:var(--warn);font-size:10px}
.age-ok{color:var(--good)} .age-mid{color:var(--warn)} .age-old{color:var(--bad)}
.card{border:1px solid var(--line2);border-left:2px solid var(--or);
  background:#141110;border-radius:2px;padding:12px 14px;margin-bottom:9px}
.card h3{margin:0 0 3px;font-size:13px;color:var(--or);font-weight:600}
.card .meta{color:#8a6a49;font-size:11px;margin-bottom:9px}
.mixrow{display:flex;justify-content:space-between;gap:14px;padding:3px 0;
  border-bottom:1px dotted #2a2018}
.tot{display:flex;justify-content:space-between;margin-top:8px;
  padding-top:7px;border-top:1px solid var(--line);color:#ffd9a8;font-weight:600}
#status{margin:10px 0;color:#a8825c;font-size:12px;min-height:18px}
.bar{height:2px;background:#251c14;border-radius:2px;overflow:hidden;margin-top:8px}
.bar>div{height:100%;background:var(--or);width:0;transition:width .3s}
.err{color:var(--bad);border-left:2px solid var(--bad);padding-left:10px}
.prices{display:flex;flex-wrap:wrap;gap:7px;margin-top:4px}
.pill{background:#1c1610;border:1px solid var(--line2);border-radius:2px;
  padding:3px 9px;font-size:11px}
.pill b{color:var(--or);font-weight:600}
.note{color:#7d6144;font-size:11px;margin-top:12px;line-height:1.7}
</style></head><body>
<header>
  <h1>CG BUY FINDER</h1>
  <span class="sub" id="cgline">Metz Enterprise &middot; Ega</span>
</header>
<main>
  <div class="panel">
    <div class="ctl">
      <div><label>Hold (t)</label><input type=number id=hold value=784></div>
      <div><label>Radius (ly)</label><input type=number id=range value=30></div>
      <div><label>Jump empty</label><input type=number id=je value=38 step=0.1></div>
      <div><label>Jump laden</label><input type=number id=jl value=18 step=0.1></div>
      <div><label>Min supply</label><input type=number id=ms value=200></div>
      <div><label>Sort</label><select id=sort>
        <option value=cr_per_min>Credits / min</option>
        <option value=t_per_min>Tonnes / min</option>
        <option value=profit_per_t>Profit / tonne</option>
        <option value=ly>Distance</option>
      </select></div>
      <label class="chk"><input type=checkbox id=fc><span>Fleet carriers</span></label>
      <button id=go>Search</button>
    </div>
    <div id="status"></div>
    <div class="bar"><div id=barfill></div></div>
    <div class="prices" id=prices></div>
  </div>

  <div class="tabs">
    <div class="tab on" data-t="mixed">Best mixed loads</div>
    <div class="tab" data-t="single">All sources</div>
  </div>
  <div class="panel"><div id=out class=muted>Hit Search to pull live market data.</div></div>

  <div class="note">
    Sell prices from EDSM, buy prices and supply from Spansh &mdash; both live.<br>
    <b>Mixed loads</b>: your best commodity at a station is often supply-capped below your
    hold; topping up with that station's next best costs no extra travel.<br>
    <b>Trip times are estimates.</b> Jump and docking constants are approximations, and the
    supercruise curve is fitted by eye &mdash; read credits/min as an ordering, not a precise figure.<br>
    <b>Data age</b> is when a commander last reported that market. Supply figures go stale
    fast while a CG is draining them.
  </div>
</main>
<script>
var DATA=null, TAB="mixed", SORT={k:null,d:1};   // d=1 => descending
var $=function(i){return document.getElementById(i)};
var fmt=function(n){return (n==null?"-":Math.round(n).toLocaleString())};

function ageClass(d){
  if(!d) return "muted";
  var days=(Date.now()-new Date(d+"T00:00:00Z").getTime())/86400000;
  return days<=21?"age-ok":(days<=120?"age-mid":"age-old");
}
function ageTxt(d){
  if(!d) return "?";
  var days=Math.round((Date.now()-new Date(d+"T00:00:00Z").getTime())/86400000);
  if(days<1) return "today";
  return days+"d ago";
}

$("sort").onchange=function(){ SORT.k=null; SORT.d=1; render(); };

document.querySelectorAll(".tab").forEach(function(t){
  t.onclick=function(){
    document.querySelectorAll(".tab").forEach(function(x){x.classList.remove("on")});
    t.classList.add("on"); TAB=t.dataset.t; render();
  };
});

$("go").onclick=function(){
  var p={hold:+$("hold").value, range:+$("range").value, jump_empty:+$("je").value,
         jump_laden:+$("jl").value, min_supply:+$("ms").value, carriers:$("fc").checked};
  $("go").disabled=true; $("out").innerHTML='<span class="muted">Searching...</span>';
  $("status").className=""; $("status").textContent="Starting...";
  fetch("/api/search",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify(p)}).then(function(){poll()});
};

function poll(){
  fetch("/api/status").then(function(r){return r.json()}).then(function(s){
    if(s.error){
      $("go").disabled=false; $("status").className="err";
      $("status").textContent=s.error; $("barfill").style.width="0";
      $("out").innerHTML=""; return;
    }
    var pct=s.total?Math.round(100*s.done/s.total):0;
    $("barfill").style.width=pct+"%";
    if(s.running){
      $("status").textContent="Fetching "+s.done+"/"+s.total+" commodities - "+s.current;
      setTimeout(poll,400); return;
    }
    if(s.ready){
      fetch("/api/results").then(function(r){return r.json()}).then(function(d){
        DATA=d; $("go").disabled=false; $("barfill").style.width="100%";
        $("status").textContent=d.rows.length+" sources across "+
          Object.keys(d.cg_prices).length+" commodities in "+d.elapsed+"s";
        $("cgline").innerHTML=d.cg_station+" &middot; "+d.cg_system+
          " &middot; "+fmt(d.cg_ls)+" Ls from arrival";
        var ps=Object.keys(d.cg_prices).sort(function(a,b){
          return d.cg_prices[b].sell-d.cg_prices[a].sell});
        $("prices").innerHTML=ps.map(function(k){
          return '<span class="pill">'+k+' <b>'+fmt(d.cg_prices[k].sell)+'</b></span>'}).join("");
        render();
      });
    } else { $("go").disabled=false; }
  }).catch(function(){ $("go").disabled=false; });
}

// If the server already holds results (page reload, second browser tab),
// show them instead of making the user re-run the whole search.
(function(){
  fetch("/api/status").then(function(r){return r.json()}).then(function(s){
    if(s.ready || s.running){ $("go").disabled = s.running; poll(); }
  }).catch(function(){});
})();

function render(){
  if(!DATA){return}
  $("out").innerHTML = TAB==="mixed" ? renderMixed() : renderSingle();
  if(TAB==="single"){
    document.querySelectorAll("#tbl th").forEach(function(th){
      th.onclick=function(){
        var k=th.dataset.k; if(!k) return;
        SORT.d = (SORT.k===k) ? -SORT.d : 1; SORT.k=k; render();
      };
    });
  }
}

function renderMixed(){
  var p=DATA.mixed.slice(0,25);
  if(!p.length) return '<span class="muted">Nothing found. Widen the radius.</span>';
  return p.map(function(x,i){
    var rows=x.mix.map(function(m){
      return '<div class="mixrow"><span><span class="big">'+fmt(m.tonnes)+'t</span> '+
        '<span class="cm">'+m.commodity+'</span> '+
        '<span class="muted">buy '+fmt(m.buy)+' &rarr; +'+fmt(m.profit_per_t)+'/t</span></span>'+
        '<span>'+fmt(m.value)+'</span></div>';
    }).join("");
    return '<div class="card"><h3>'+(i+1)+'. '+x.station+
      (x.carrier?' <span class="fc">[CARRIER]</span>':'')+'</h3>'+
      '<div class="meta">'+x.system+' &middot; '+x.ly.toFixed(1)+' ly &middot; '+
      fmt(x.ls)+' Ls &middot; <span class="'+ageClass(x.updated)+'">data '+
      ageTxt(x.updated)+'</span>'+(x.short?' &middot; '+fmt(x.short)+'t short':'')+'</div>'+
      rows+'<div class="tot"><span>'+fmt(x.total)+' cr per ~'+
      Math.round(x.trip_minutes)+' min</span><span>'+fmt(x.cr_per_min)+' cr/min</span></div></div>';
  }).join("");
}

function renderSingle(){
  var k=SORT.k||$("sort").value, d=SORT.d;
  var r=DATA.rows.slice().sort(function(a,b){
    var x=a[k],y=b[k];
    if(typeof x==="string") return d*(x<y?1:x>y?-1:0);
    return d*(y-x);
  }).slice(0,150);
  if(!r.length) return '<span class="muted">Nothing found. Widen the radius.</span>';
  var cols=[["commodity","Commodity",1],["station","Station",1],["system","System",1],
    ["ly","Ly"],["ls","Ls"],["supply","Supply"],["loads_available","Loads"],
    ["buy","Buy"],["profit_per_t","Profit/t"],["trip_minutes","Trip"],
    ["cr_per_min","Cr/min"],["t_per_min","T/min"],["updated","Data"]];
  var head=cols.map(function(c){
    var cls=(c[2]?"l ":"")+(k===c[0]?"arrow"+(d>0?"":" up"):"");
    return '<th class="'+cls+'" data-k="'+c[0]+'">'+c[1]+'</th>';
  }).join("");
  var body=r.map(function(x){
    return '<tr><td class="l cm">'+x.commodity+'</td>'+
      '<td class="l">'+x.station+(x.carrier?' <span class="fc">[FC]</span>':'')+'</td>'+
      '<td class="l muted">'+x.system+'</td>'+
      '<td>'+x.ly.toFixed(1)+'</td><td>'+fmt(x.ls)+'</td>'+
      '<td>'+fmt(x.supply)+'</td><td>'+x.loads_available+'</td>'+
      '<td>'+fmt(x.buy)+'</td><td class="big">'+fmt(x.profit_per_t)+'</td>'+
      '<td>'+Math.round(x.trip_minutes)+'m</td>'+
      '<td class="big">'+fmt(x.cr_per_min)+'</td><td>'+x.t_per_min+'</td>'+
      '<td class="'+ageClass(x.updated)+'">'+ageTxt(x.updated)+'</td></tr>';
  }).join("");
  var cap = DATA.rows.length>150
    ? '<div class="note">Showing the top 150 of '+fmt(DATA.rows.length)+
      ' sources by the current sort.</div>' : '';
  return '<div style="overflow-x:auto"><table id=tbl><thead><tr>'+head+
    '</tr></thead><tbody>'+body+'</tbody></table></div>'+cap;
}
</script></body></html>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html"):
            return self._send(200, HTML, "text/html; charset=utf-8")
        if path == "/api/status":
            with JOB_LOCK:
                s = {"running": JOB["running"], "done": JOB["done"],
                     "total": JOB["total"], "current": JOB["current"],
                     "error": JOB["error"], "ready": JOB["payload"] is not None}
            return self._send(200, json.dumps(s), "application/json")
        if path == "/api/results":
            with JOB_LOCK:
                p = JOB["payload"]
            if p is None:
                return self._send(404, '{"error":"no results"}', "application/json")
            return self._send(200, json.dumps(p), "application/json")
        self._send(404, "not found", "text/plain")

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/api/search":
            return self._send(404, "not found", "text/plain")
        n = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._send(400, '{"error":"bad json"}', "application/json")
        with JOB_LOCK:
            if JOB["running"]:
                return self._send(409, '{"error":"already running"}',
                                  "application/json")
        params = {
            "hold": max(1, int(body.get("hold", 784))),
            "range": max(1.0, float(body.get("range", 30))),
            "jump_empty": max(1.0, float(body.get("jump_empty", 38))),
            "jump_laden": max(1.0, float(body.get("jump_laden", 18))),
            "min_supply": max(0, int(body.get("min_supply", 200))),
            "carriers": bool(body.get("carriers", False)),
        }
        threading.Thread(target=run_job, args=(params,), daemon=True).start()
        self._send(200, '{"started":true}', "application/json")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser(description="CG buy finder UI")
    ap.add_argument("--port", type=int, default=8731)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()

    port = a.port
    for attempt in range(20):
        try:
            srv = Server(("127.0.0.1", port), Handler)
            break
        except OSError:
            port += 1
    else:
        sys.exit("Could not bind a port in range %d-%d" % (a.port, a.port + 19))

    url = "http://127.0.0.1:%d/" % port
    print("CG buy finder -> %s   (Ctrl+C to quit)" % url)
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        srv.shutdown()


if __name__ == "__main__":
    main()
