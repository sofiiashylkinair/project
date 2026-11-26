/* SafeZone map module (Leaflet + OpenStreetMap, без ключів).
 * Підключення:
 *   <link rel="stylesheet" href="map/map.css">
 *   <div id="map" style="height:600px"></div>
 *   <script src="map/map.js"></script>
 *   SafeZoneMap.init({ container: "map", apiUrl: "http://127.0.0.1:8000" }).then(function (m) { ... });
 * Leaflet і heatmap-плагін підтягуються самі (один раз, навіть якщо карт на сторінці кілька).
 */
(function (global) {
  "use strict";

  var LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
  var LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
  var HEAT_JS = "https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js";

  var WEIGHTS = { violent: 3, robbery: 2, burglary: 2, theft: 1 };
  var COLORS = { violent: "#d6453f", robbery: "#e0a12d", burglary: "#7a5cc7", theft: "#1f8f6f" };
  var LABELS = { violent: "Насильницький злочин", robbery: "Грабіж / напад", burglary: "Квартирна крадіжка", theft: "Крадіжка" };
  var TIMES = { morning: "ранок", day: "день", evening: "вечір", night: "ніч" };
  var LEVEL_TEXT = { low: "Низький ризик", moderate: "Помірний ризик", high: "Високий ризик" };

  var depsPromise = null;
  var dataCache = {};

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
  function loadDeps() {
    if (!depsPromise) {
      loadCss(LEAFLET_CSS);
      depsPromise = loadScript(LEAFLET_JS).then(function () { return loadScript(HEAT_JS); });
    }
    return depsPromise;
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
  // "Тип злочину, вул. Назва" -> "вул. Назва"
  function placeOf(i) {
    var p = String(i.description || "").split(", ").slice(1).join(", ");
    return p || i.description || "Невідоме місце";
  }

  function init(opts) {
    var o = {
      container: "map",
      apiUrl: "http://127.0.0.1:8000",
      fallbackUrl: null,            // напр. "backend/incidents.json", якщо сервер недоступний
      center: [49.8397, 24.0297],   // центр Львова
      zoom: 12,
      radius: 500,                  // радіус оцінки ризику, м
      interactive: true,            // false = карта-превʼю без кліків і перетягування
      heat: true,
      markers: true,
      onIncidentClick: null,        // function (incident)
      onAreaCheck: null,            // function (risk, latlng, name)
      onRoute: null,                // function (result)
      onMove: null,                 // function () після переміщення/масштабу
      onError: null                 // function (message)
    };
    for (var k in (opts || {})) o[k] = opts[k];
    return loadDeps().then(function () { return build(o); });
  }

  function build(o) {
    var el = typeof o.container === "string" ? document.getElementById(o.container) : o.container;
    el.classList.add("szmap");
    var mapOpts = o.interactive ? {} : {
      dragging: false, touchZoom: false, scrollWheelZoom: false, doubleClickZoom: false,
      boxZoom: false, keyboard: false, zoomControl: false, tap: false
    };
    var map = L.map(el, mapOpts).setView(o.center, o.zoom);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap"
    }).addTo(map);

    var state = { incidents: [], category: "all", timeOfDay: null, heat: o.heat, markers: o.markers, mode: null, pts: [] };
    var markerLayer = L.layerGroup().addTo(map);
    var routeLayer = L.layerGroup().addTo(map);
    var pointLayer = L.layerGroup().addTo(map);
    var selLayer = L.layerGroup().addTo(map);
    var heatLayer = null;

    function catOk(i) { return state.category === "all" || i.category === state.category; }
    function visible() {
      return state.incidents.filter(function (i) {
        if (!catOk(i)) return false;
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

    // Ризик навколо точки. allTimes=true ігнорує фільтр часу доби (для графіка за часом).
    function riskAt(ll, radius, allTimes) {
      var pool = allTimes ? state.incidents.filter(catOk) : visible();
      var near = pool.filter(function (i) { return dist(ll, [i.latitude, i.longitude]) <= radius; });
      var score = 0, by = {}, byTime = { morning: 0, day: 0, evening: 0, night: 0 }, unknown = 0;
      near.forEach(function (i) {
        var w = WEIGHTS[i.crime_type] || 1;
        score += w;
        by[i.crime_type] = (by[i.crime_type] || 0) + 1;
        if (i.time_of_day && byTime[i.time_of_day] !== undefined) byTime[i.time_of_day] += w;
        else unknown++;
      });
      return { level: levelOf(score), score: score, count: near.length, byType: by,
               byTime: byTime, unknownTime: unknown, radius: radius };
    }

    // "Місця поруч": події групуються за місцем, сортуються за відстанню до центру карти
    function nearby(limit) {
      var c = map.getCenter(), groups = {};
      visible().forEach(function (i) {
        var key = placeOf(i);
        var g = groups[key] || (groups[key] = { place: key, lat: 0, lon: 0, count: 0, score: 0, byType: {} });
        g.lat += i.latitude; g.lon += i.longitude; g.count++;
        g.score += WEIGHTS[i.crime_type] || 1;
        g.byType[i.crime_type] = (g.byType[i.crime_type] || 0) + 1;
      });
      return Object.keys(groups).map(function (k) {
        var g = groups[k];
        g.lat /= g.count; g.lon /= g.count;
        g.level = levelOf(g.score);
        g.distance = dist([c.lat, c.lng], [g.lat, g.lon]);
        return g;
      }).sort(function (a, b) { return a.distance - b.distance; }).slice(0, limit || 3);
    }

    function defaultPopup(ll, r) {
      var html = "<b>" + LEVEL_TEXT[r.level] + "</b><br>Подій у радіусі " + r.radius + " м: " + r.count;
      Object.keys(r.byType).forEach(function (t) { html += "<br>• " + (LABELS[t] || t) + ": " + r.byType[t]; });
      L.popup().setLatLng(ll).setContent(html).openOn(map);
    }

    // Вибір точки: ставить позначку, рахує ризик, повідомляє сторінку
    function select(ll, opts) {
      opts = opts || {};
      selLayer.clearLayers();
      L.circleMarker(ll, { radius: 11, color: "#10302b", weight: 3, fillColor: "#fff", fillOpacity: 1 }).addTo(selLayer);
      if (opts.zoom) map.setView(ll, opts.zoom);
      var r = riskAt(ll, o.radius);
      if (o.onAreaCheck) o.onAreaCheck(r, ll, opts.name || null);
      else defaultPopup(ll, r);
      return r;
    }

    function fetchData(force) {
      var key = o.apiUrl + "|" + o.fallbackUrl;
      if (!force && dataCache[key]) return dataCache[key];
      var p = fetch(o.apiUrl + "/incidents")
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .catch(function (err) {
          if (!o.fallbackUrl) throw err;
          return fetch(o.fallbackUrl).then(function (r) { return r.json(); });
        });
      dataCache[key] = p.catch(function (e) { delete dataCache[key]; throw e; });
      return dataCache[key];
    }
    function load(force) {
      return fetchData(force).then(function (data) { state.incidents = data; render(); return data; });
    }

    // ---- безпечний маршрут: з кількох пішохідних варіантів обираємо найменш ризиковий
    function fail(e) { if (o.onError) o.onError(e.message || String(e)); else alert(e.message || e); }
    function dot(ll, color) {
      return L.circleMarker(ll, { radius: 9, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1 }).addTo(pointLayer);
    }
    function startRoute(from) {
      routeLayer.clearLayers(); pointLayer.clearLayers();
      state.pts = []; state.mode = "route";
      if (from) { var ll = L.latLng(from[0], from[1]); state.pts.push(ll); dot(ll, "#10302b"); }
    }
    function routePoint(ll) {
      state.pts.push(ll);
      dot(ll, state.pts.length === 1 ? "#10302b" : "#d6453f");
      if (state.pts.length === 2) {
        state.mode = null;
        buildRoute(state.pts[0], state.pts[1]).catch(fail);
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
        L.polyline(best.pts, { color: "#10302b", weight: 5, dashArray: "8 8" }).addTo(routeLayer);
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
      var url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ua&accept-language=uk&q=" +
        encodeURIComponent(text + ", Львів");
      return fetch(url).then(function (r) { return r.json(); }).then(function (r) {
        if (!r.length) throw new Error("Адресу не знайдено");
        var ll = [parseFloat(r[0].lat), parseFloat(r[0].lon)];
        return { latlng: ll, risk: select(ll, { zoom: 16, name: text }) };
      });
    }

    function streetName(ll) {
      var url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&accept-language=uk&lat=" +
        ll[0] + "&lon=" + ll[1];
      return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
        var a = (d && d.address) || {};
        return a.road || a.pedestrian || a.footway || a.neighbourhood || a.suburb || null;
      });
    }

    if (o.interactive) {
      map.on("click", function (e) {
        if (state.mode === "route") return routePoint(e.latlng);
        select([e.latlng.lat, e.latlng.lng]);
      });
    }
    map.on("moveend", function () { if (o.onMove) o.onMove(); });

    var api = {
      map: map,
      reload: function () { return load(true); },
      setProfile: function (c) { state.category = c || "all"; render(); },     // "all" | "tourist" | "real_estate"
      setTimeOfDay: function (t) { state.timeOfDay = t || null; render(); },   // null | morning | day | evening | night
      setLayers: function (v) {
        if (v.heat !== undefined) state.heat = v.heat;
        if (v.markers !== undefined) state.markers = v.markers;
        render();
      },
      startRoute: startRoute,            // startRoute([lat, lon]) — початок уже відомий, лишається клікнути кінець
      goToAddress: goToAddress,
      select: function (lat, lon, opts) { return select([lat, lon], opts); },
      streetName: streetName,
      nearby: nearby,
      riskAt: function (lat, lon, radius, allTimes) { return riskAt([lat, lon], radius || o.radius, allTimes); },
      getVisible: visible
    };
    return load().catch(function (e) {
      console.error("SafeZone: не вдалося завантажити дані", e);
      if (o.onError) o.onError("Не вдалося завантажити дані карти");
    }).then(function () { return api; });
  }

  global.SafeZoneMap = { init: init };
})(window);
