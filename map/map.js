/* SafeZone map module (Leaflet + OpenStreetMap, без ключів).
 * Підключення на сторінці:
 *   <link rel="stylesheet" href="map/map.css">
 *   <div id="map" style="height:600px"></div>
 *   <script src="map/map.js"></script>
 *   <script>
 *     SafeZoneMap.init({ container: "map", apiUrl: "http://127.0.0.1:8000" }).then(function (m) { ... });
 *   </script>
 * Leaflet і heatmap-плагін підтягуються самі.
 */
(function (global) {
  "use strict";

  var LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
  var LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
  var HEAT_JS = "https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js";

  var WEIGHTS = { violent: 3, robbery: 2, burglary: 2, theft: 1 };
  var COLORS = { violent: "#d64545", robbery: "#e0a22d", burglary: "#7a5cc7", theft: "#2a9d74" };
  var LABELS = { violent: "Насильницький злочин", robbery: "Грабіж / напад", burglary: "Квартирна крадіжка", theft: "Крадіжка" };
  var TIMES = { morning: "ранок", day: "день", evening: "вечір", night: "ніч" };
  var LEVEL_TEXT = { low: "Низький ризик", moderate: "Помірний ризик", high: "Високий ризик" };

  function loadCss(href) {
    if (document.querySelector('link[href="' + href + '"]')) return;
    var l = document.createElement("link");
    l.rel = "stylesheet"; l.href = href;
    document.head.appendChild(l);
  }
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src; s.onload = res;
      s.onerror = function () { rej(new Error("Не завантажився " + src)); };
      document.head.appendChild(s);
    });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function dist(a, b) { // метри між [lat,lon] і [lat,lon]
    var R = 6371000, r = Math.PI / 180;
    var dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function levelOf(score) { return score <= 2 ? "low" : score <= 6 ? "moderate" : "high"; }

  function init(opts) {
    var o = {
      container: "map",
      apiUrl: "http://127.0.0.1:8000",
      fallbackUrl: null,            // напр. "../backend/incidents.json", якщо сервер не запущено
      center: [49.8397, 24.0297],   // центр Львова
      zoom: 12,
      radius: 500,                  // радіус оцінки ризику, м
      onIncidentClick: null,        // function (incident)
      onAreaCheck: null,            // function (risk, latlng)
      onRoute: null                 // function (result)
    };
    for (var k in (opts || {})) o[k] = opts[k];
    loadCss(LEAFLET_CSS);
    return loadScript(LEAFLET_JS)
      .then(function () { return loadScript(HEAT_JS); })
      .then(function () { return build(o); });
  }

  function build(o) {
    var el = typeof o.container === "string" ? document.getElementById(o.container) : o.container;
    el.classList.add("szmap");
    var map = L.map(el).setView(o.center, o.zoom);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap"
    }).addTo(map);

    var state = { incidents: [], category: "all", timeOfDay: null, heat: true, markers: true, mode: null, pts: [] };
    var markerLayer = L.layerGroup().addTo(map);
    var routeLayer = L.layerGroup().addTo(map);
    var pointLayer = L.layerGroup().addTo(map);
    var heatLayer = null;

    function visible() {
      return state.incidents.filter(function (i) {
        if (state.category !== "all" && i.category !== state.category) return false;
        if (state.timeOfDay && i.time_of_day && i.time_of_day !== state.timeOfDay) return false;
        return true;
      });
    }

    function popupHtml(i) {
      var t = i.time_of_day ? "<br>Час доби: " + TIMES[i.time_of_day] : "";
      var a = i.approx ? "<br><small>Місце наближене</small>" : "";
      return "<b>" + esc(LABELS[i.crime_type] || "Подія") + "</b><br>" + esc(i.description) + t + a;
    }

    function render() {
      markerLayer.clearLayers();
      if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
      var list = visible();
      if (state.heat) {
        heatLayer = L.heatLayer(list.map(function (i) {
          return [i.latitude, i.longitude, (WEIGHTS[i.crime_type] || 1) / 3];
        }), { radius: 35, blur: 30, maxZoom: 15 }).addTo(map);
      }
      if (state.markers) {
        list.forEach(function (i) {
          var m = L.circleMarker([i.latitude, i.longitude], {
            radius: 7, color: "#fff", weight: 2,
            fillColor: COLORS[i.crime_type] || "#555", fillOpacity: 0.95
          }).addTo(markerLayer).bindPopup(popupHtml(i));
          m.on("click", function () { if (o.onIncidentClick) o.onIncidentClick(i); });
        });
      }
    }

    function riskAt(ll, radius) {
      var near = visible().filter(function (i) { return dist(ll, [i.latitude, i.longitude]) <= radius; });
      var score = 0, by = {};
      near.forEach(function (i) {
        score += WEIGHTS[i.crime_type] || 1;
        by[i.crime_type] = (by[i.crime_type] || 0) + 1;
      });
      return { level: levelOf(score), score: score, count: near.length, byType: by, radius: radius };
    }

    function showArea(ll, r) {
      var html = '<b class="sz-risk-' + r.level + '">' + LEVEL_TEXT[r.level] + "</b><br>Подій у радіусі " +
        r.radius + " м: " + r.count;
      Object.keys(r.byType).forEach(function (t) {
        html += "<br>• " + (LABELS[t] || t) + ": " + r.byType[t];
      });
      L.popup().setLatLng(ll).setContent(html).openOn(map);
      if (o.onAreaCheck) o.onAreaCheck(r, ll);
    }

    function load() {
      return fetch(o.apiUrl + "/incidents")
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .catch(function (err) {
          if (!o.fallbackUrl) throw err;
          return fetch(o.fallbackUrl).then(function (r) { return r.json(); });
        })
        .then(function (data) { state.incidents = data; render(); return data; });
    }

    // ---- безпечний маршрут: з кількох пішохідних варіантів обираємо найменш ризиковий
    function startRoute() {
      state.mode = "route"; state.pts = [];
      routeLayer.clearLayers(); pointLayer.clearLayers();
    }
    function routePoint(ll) {
      state.pts.push(ll);
      L.marker(ll).addTo(pointLayer);
      if (state.pts.length === 2) {
        state.mode = null;
        buildRoute(state.pts[0], state.pts[1]).catch(function (e) { alert(e.message); });
      }
    }
    function buildRoute(a, b) {
      var url = "https://routing.openstreetmap.de/routed-foot/route/v1/foot/" +
        a.lng + "," + a.lat + ";" + b.lng + "," + b.lat +
        "?overview=full&geometries=geojson&alternatives=true";
      return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.routes || !d.routes.length) throw new Error("Маршрут не знайдено");
        var list = visible();
        var scored = d.routes.map(function (rt) {
          var pts = rt.geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
          var score = 0;
          list.forEach(function (i) {
            var p = [i.latitude, i.longitude];
            for (var k = 0; k < pts.length; k++) {
              if (dist(p, pts[k]) <= 150) { score += WEIGHTS[i.crime_type] || 1; break; }
            }
          });
          return { rt: rt, pts: pts, score: score };
        });
        scored.sort(function (x, y) { return x.score - y.score || x.rt.distance - y.rt.distance; });
        routeLayer.clearLayers();
        scored.slice(1).forEach(function (s) {
          L.polyline(s.pts, { color: "#999", weight: 4, opacity: 0.7 }).addTo(routeLayer);
        });
        var best = scored[0];
        L.polyline(best.pts, { color: "#12302b", weight: 5, dashArray: "8 8" }).addTo(routeLayer);
        map.fitBounds(L.latLngBounds(best.pts), { padding: [40, 40] });
        var res = {
          score: best.score, level: levelOf(best.score),
          distanceM: Math.round(best.rt.distance), durationMin: Math.round(best.rt.duration / 60),
          alternatives: scored.length
        };
        if (o.onRoute) o.onRoute(res);
        return res;
      });
    }

    function goToAddress(text) {
      var url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ua&q=" +
        encodeURIComponent(text + ", Львів");
      return fetch(url).then(function (r) { return r.json(); }).then(function (r) {
        if (!r.length) throw new Error("Адресу не знайдено");
        var ll = [parseFloat(r[0].lat), parseFloat(r[0].lon)];
        map.setView(ll, 16);
        var risk = riskAt(ll, o.radius);
        showArea(ll, risk);
        return { latlng: ll, risk: risk };
      });
    }

    map.on("click", function (e) {
      if (state.mode === "route") return routePoint(e.latlng);
      showArea([e.latlng.lat, e.latlng.lng], riskAt([e.latlng.lat, e.latlng.lng], o.radius));
    });

    var api = {
      map: map,
      reload: load,
      setProfile: function (c) { state.category = c || "all"; render(); },          // "all" | "tourist" | "real_estate"
      setTimeOfDay: function (t) { state.timeOfDay = t || null; render(); },        // null | morning | day | evening | night
      setLayers: function (v) {
        if (v.heat !== undefined) state.heat = v.heat;
        if (v.markers !== undefined) state.markers = v.markers;
        render();
      },
      startRoute: startRoute,
      goToAddress: goToAddress,
      riskAt: function (lat, lon, radius) { return riskAt([lat, lon], radius || o.radius); },
      getVisible: visible
    };
    return load().catch(function (e) { console.error("SafeZone: не вдалося завантажити дані", e); }).then(function () { return api; });
  }

  global.SafeZoneMap = { init: init };
})(window);
