const express = require("express");
const crypto = require("crypto");
const app = express();
app.use(express.json());

// links: token -> { label, created }
// hits: token -> [ {lat,lng,acc,at,ip}, ... ]  (latest last)
const links = new Map();
const hits = new Map();

// --- Create a unique link for a person -------------------------------------
// e.g. open http://localhost:3000/new?label=Alex
app.get("/new", (req, res) => {
  const token = crypto.randomBytes(6).toString("hex");
  const label = (req.query.label || "unnamed").toString().slice(0, 40);
  links.set(token, { label, created: new Date().toISOString() });
  hits.set(token, []);
  const base = `${req.protocol}://${req.get("host")}`;
  res.send(`<body style="font-family:sans-serif;padding:40px">
    <h2>Link created for "${label}"</h2>
    <p>Send this link:</p>
    <p><a href="${base}/t/${token}">${base}/t/${token}</a></p>
    <p><a href="/dashboard">Go to dashboard</a></p>
  </body>`);
});

// --- The page the person opens (per-token, live sharing) --------------------
app.get("/t/:token", (req, res) => {
  const { token } = req.params;
  if (!links.has(token)) return res.status(404).send("Unknown link.");
  res.send(`<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Share location</title></head>
<body style="font-family:sans-serif;text-align:center;padding:40px">
  <h2>Share your location?</h2>
  <p id="status">Tap to start sharing live.</p>
  <button id="btn" onclick="toggle()" style="padding:14px 24px;font-size:16px">Start sharing</button>
  <script>
    let watchId = null;
    function send(p){
      fetch("/loc/${token}", {method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({lat:p.coords.latitude, lng:p.coords.longitude, acc:p.coords.accuracy})});
    }
    function toggle(){
      const s = document.getElementById("status"), btn = document.getElementById("btn");
      if(watchId !== null){
        navigator.geolocation.clearWatch(watchId); watchId = null;
        btn.textContent="Start sharing"; s.textContent="Stopped."; return;
      }
      if(!navigator.geolocation){ s.textContent="Geolocation not supported."; return; }
      s.textContent="Requesting permission...";
      watchId = navigator.geolocation.watchPosition(
        p => { send(p); s.textContent="Sharing live ✓ (±"+Math.round(p.coords.accuracy)+"m)"; },
        e => { s.textContent="Denied or unavailable: " + e.message; watchId=null; btn.textContent="Start sharing"; },
        {enableHighAccuracy:true, maximumAge:0, timeout:15000}
      );
      btn.textContent="Stop sharing";
    }
  </script>
</body>
</html>`);
});

// --- Receive a location update ---------------------------------------------
app.post("/loc/:token", (req, res) => {
  const { token } = req.params;
  if (!hits.has(token)) return res.status(404).json({ ok: false });
  const { lat, lng, acc } = req.body;
  hits.get(token).push({ lat, lng, acc, at: new Date().toISOString(), ip: req.ip });
  res.json({ ok: true });
});

// --- JSON feed for the map (latest point per person) -----------------------
app.get("/feed", (req, res) => {
  const out = [];
  for (const [token, meta] of links) {
    const arr = hits.get(token);
    if (arr && arr.length) out.push({ label: meta.label, ...arr[arr.length - 1] });
  }
  res.json(out);
});

// --- Dashboard with a live map ---------------------------------------------
app.get("/dashboard", (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dashboard</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>body{margin:0;font-family:sans-serif} #map{height:70vh} .bar{padding:10px 16px}</style>
</head>
<body>
  <div class="bar"><b>Live locations</b> &middot; <a href="/new?label=person">create a link</a></div>
  <div id="map"></div>
  <script>
    const map = L.map("map").setView([20, 0], 2);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {attribution:"&copy; OpenStreetMap"}).addTo(map);
    const markers = {};
    let fitted = false;
    async function tick(){
      const data = await (await fetch("/feed")).json();
      const pts = [];
      for (const d of data){
        pts.push([d.lat, d.lng]);
        const text = d.label + "<br>±" + Math.round(d.acc) + "m<br>" + d.at;
        if (markers[d.label]) markers[d.label].setLatLng([d.lat,d.lng]).setPopupContent(text);
        else markers[d.label] = L.marker([d.lat,d.lng]).addTo(map).bindPopup(text);
      }
      if (!fitted && pts.length){ map.fitBounds(pts, {maxZoom:16, padding:[40,40]}); fitted = true; }
    }
    tick(); setInterval(tick, 3000);
  </script>
</body>
</html>`);
});

app.get("/", (req, res) => res.redirect("/dashboard"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port " + PORT));
