const screens = document.querySelectorAll('.screen');
const startScreen = 'screen-situation';

// ---------- Підказка-повідомлення ----------
const toast = document.getElementById('toast');
let toastTimer;

function showToast(text, ms = 2000) {
  toast.textContent = text;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), ms);
}

// ---------- Константи ----------
const PROFILES = {
  'Купівля житла': 'real_estate',
  'Туристичний маршрут': 'tourist',
  'Вечірня прогулянка': 'all'
};
const TIMES = { 'Ранок': 'morning', 'День': 'day', 'Вечір': 'evening', 'Ніч': 'night' };
const TIME_NAMES = { morning: 'Ранок', day: 'День', evening: 'Вечір', night: 'Ніч' };
const LEVELS = {
  low: ['Низький ризик', 'badge--low', 'low'],
  moderate: ['Помірний ризик', 'badge--medium', 'medium'],
  high: ['Високий ризик', 'badge--high', 'high']
};
const TYPE_NAMES = { theft: 'Крадіжки', robbery: 'Грабежі', burglary: 'Квартирні крадіжки', violent: 'Напади' };
const TYPE_WORDS = { theft: 'крадіжки', robbery: 'грабежі', burglary: 'квартирні крадіжки', violent: 'напади' };

// Сервер є лише на комп'ютері розробника; на GitHub Pages беремо дані з файлу
const local = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
const MAP_OPTS = {
  apiUrl: local ? 'http://127.0.0.1:8000' : '',
  fallbackUrl: 'backend/incidents.json'
};

// ---------- Стан ----------
let szMap = null;          // велика карта (екран 2)
let szMapLoading = false;
let previewMap = null;     // мала карта (екран 1)
let lastPoint = null;      // { ll: [lat, lon], name, risk }
let selectedPlace = null;
let pendingRoute = false;
let nameToken = 0;
let ignoreMoveUntil = 0;
let moveTimer;

// ---------- Допоміжне ----------
function currentChoice() {
  const situation = document.querySelector('#screen-situation .option.is-selected strong')?.textContent.trim();
  const time = document.querySelector('#screen-situation .chip.is-selected')?.textContent.trim();
  return { situation, time, profile: PROFILES[situation] || 'all', timeOfDay: TIMES[time] || null };
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
const eventsText = (n) => `${n} ${plural(n, 'подія', 'події', 'подій')}`;

function topType(byType) {
  const sorted = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  return sorted.length ? TYPE_WORDS[sorted[0][0]] : null;
}

// ---------- Картка на карті ----------
function showCard(name, risk) {
  const [label, cls] = LEVELS[risk.level];
  const badge = document.getElementById('popup-badge');
  badge.textContent = label;
  badge.className = 'badge ' + cls;
  const situation = (currentChoice().situation || '').toLowerCase();
  document.getElementById('popup-for').textContent = situation ? 'для: ' + situation : '';
  document.getElementById('popup-title').textContent = name;
  const main = topType(risk.byType);
  document.getElementById('popup-text').textContent = risk.count
    ? `${eventsText(risk.count)} у радіусі ${risk.radius} м${main ? ', переважно ' + main : ''}.`
    : `У радіусі ${risk.radius} м подій у базі не знайдено.`;
}

// Користувач клікнув на карті / обрав місце / знайшов адресу
function onArea(risk, ll, name) {
  lastPoint = { ll, name: name || 'Обрана точка', risk };
  selectedPlace = name || null;
  showCard(lastPoint.name, risk);
  if (!name) {
    // назву вулиці беремо з OpenStreetMap
    const token = ++nameToken;
    szMap.streetName(ll).then((street) => {
      if (token !== nameToken || !street) return;
      lastPoint.name = street;
      showCard(street, risk);
    }).catch(() => {});
  }
}

// ---------- Список «Місця поруч» ----------
function renderStreets() {
  if (!szMap) return;
  const box = document.getElementById('streets');
  const items = szMap.nearby(3);
  box.innerHTML = '';
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Для цього профілю й часу подій у базі немає.';
    box.append(p);
    return;
  }
  items.forEach((it) => {
    const b = document.createElement('button');
    b.className = 'street' + (it.place === selectedPlace ? ' is-selected' : '');
    b.dataset.lat = it.lat;
    b.dataset.lon = it.lon;
    b.dataset.place = it.place;
    const s = document.createElement('strong');
    s.textContent = it.place;
    const sp = document.createElement('span');
    sp.textContent = `${LEVELS[it.level][0]} · ${eventsText(it.count)} у базі`;
    b.append(s, sp);
    box.append(b);
  });
}

function selectStreet(place, lat, lon) {
  ignoreMoveUntil = Date.now() + 1500; // не перебудовуємо список, поки карта їде до місця
  szMap.select(lat, lon, { zoom: 16, name: place });
  selectedPlace = place;
  document.querySelectorAll('#streets .street').forEach((b) => {
    b.classList.toggle('is-selected', b.dataset.place === place);
  });
}

document.getElementById('streets').addEventListener('click', (event) => {
  const b = event.target.closest('.street');
  if (!b || !szMap) return;
  selectStreet(b.dataset.place, Number(b.dataset.lat), Number(b.dataset.lon));
});

function onMapMove() {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    if (Date.now() < ignoreMoveUntil) return;
    renderStreets();
  }, 400);
}

// ---------- Маршрут ----------
function startRouteFlow() {
  if (!szMap) return;
  const from = lastPoint ? lastPoint.ll : null;
  szMap.startRoute(from);
  showToast(
    from ? 'Початок — обране місце. Клікніть на карті, куди хочете дійти'
         : 'Клікніть початкову точку, потім кінцеву',
    5000
  );
}

// ---------- Велика карта (екран 2) ----------
function showSafeZoneMap() {
  const c = currentChoice();

  // підписи в бічній панелі
  const tags = document.querySelectorAll('.sidebar .tag');
  if (tags[0] && c.situation) tags[0].textContent = c.situation;
  if (tags[1] && c.time) tags[1].textContent = c.time;

  const apply = () => {
    szMap.setProfile(c.profile);
    szMap.setTimeOfDay(c.timeOfDay);
    szMap.map.invalidateSize(); // екран був прихований — перераховуємо розмір
    renderStreets();
    if (lastPoint) {
      szMap.select(lastPoint.ll[0], lastPoint.ll[1], { name: lastPoint.name });
    } else {
      const first = szMap.nearby(1)[0];
      if (first) selectStreet(first.place, first.lat, first.lon);
    }
    if (pendingRoute) { pendingRoute = false; startRouteFlow(); }
  };

  if (szMap) { apply(); return; }
  if (szMapLoading || !window.SafeZoneMap) return;
  szMapLoading = true;

  SafeZoneMap.init({
    container: 'map',
    ...MAP_OPTS,
    onAreaCheck: onArea,
    onMove: onMapMove,
    onError: (msg) => showToast(msg, 4000),
    onRoute: (r) => showToast(
      `Безпечніший маршрут: ${r.distanceM} м, ~${r.durationMin} хв, ${LEVELS[r.level][0].toLowerCase()}`,
      7000
    )
  }).then((m) => { szMap = m; apply(); });
}

// ---------- Мала карта (екран 1) ----------
function initPreviewMap() {
  if (!window.SafeZoneMap) return;
  SafeZoneMap.init({
    container: 'map-preview',
    ...MAP_OPTS,
    interactive: false,
    markers: false
  }).then((m) => {
    previewMap = m;
    const c = currentChoice();
    m.setProfile(c.profile);
    m.setTimeOfDay(c.timeOfDay);
  });
}

// ---------- Екран 3: деталі ----------
function fillDetails() {
  const c = currentChoice();
  let p = lastPoint;
  if (!p) {
    const first = szMap.nearby(1)[0];
    if (first) p = { ll: [first.lat, first.lon], name: first.place };
  }
  if (!p) return;

  const [lat, lon] = p.ll;
  const r = szMap.riskAt(lat, lon);              // з урахуванням профілю й часу
  const rt = szMap.riskAt(lat, lon, undefined, true); // усі часи доби — для графіка

  document.getElementById('details-title').textContent = p.name;
  document.getElementById('details-for').textContent =
    'Для вашої ситуації: ' + (c.situation || '').toLowerCase() + (c.time ? ', ' + c.time.toLowerCase() : '');
  document.getElementById('details-risk').textContent = LEVELS[r.level][0];
  document.querySelectorAll('.scale__item').forEach((el) => el.classList.remove('is-current'));
  document.querySelector('.scale__item--' + LEVELS[r.level][2]).classList.add('is-current');

  // що саме трапляється
  const types = ['theft', 'robbery', 'burglary', 'violent'];
  const maxType = Math.max(1, ...types.map((t) => r.byType[t] || 0));
  document.getElementById('bars').innerHTML = types.map((t) => {
    const n = r.byType[t] || 0;
    const w = n ? Math.max(8, Math.round((n / maxType) * 100)) : 0;
    return `<div class="bar-row"><span>${TYPE_NAMES[t]} · ${n}</span><div class="bar"><i style="width:${w}%"></i></div></div>`;
  }).join('');

  // ризик за часом доби
  const times = ['morning', 'day', 'evening', 'night'];
  const maxScore = Math.max(...times.map((t) => rt.byTime[t]));
  document.getElementById('columns').innerHTML = times.map((t) => {
    const ratio = maxScore ? rt.byTime[t] / maxScore : 0;
    const h = maxScore ? Math.max(6, Math.round(ratio * 100)) : 6;
    const cls = ratio >= 0.67 ? 'high' : ratio >= 0.34 ? 'medium' : 'low';
    const cur = c.timeOfDay === t ? ' is-current' : '';
    return `<div class="column${cur}"><i class="${cls}" style="height:${h}%"></i>${TIME_NAMES[t]}</div>`;
  }).join('');

  const known = rt.count - rt.unknownTime;
  document.getElementById('details-note').textContent =
    `Дані: відкриті джерела та локальні новини. Подій у радіусі ${rt.radius} м: ${rt.count}, ` +
    `для ${known} з них відомий час доби. Висота стовпців відносна.`;
}

// ---------- Екрани ----------
function showScreen(id) {
  const target = document.getElementById(id) || document.getElementById(startScreen);
  screens.forEach((screen) => screen.classList.remove('is-active'));
  target.classList.add('is-active');
  window.scrollTo(0, 0);

  if (target.id === 'screen-map') showSafeZoneMap();
  if (target.id === 'screen-details') {
    if (!szMap) { location.hash = 'screen-map'; return; } // деталі без карти не мають сенсу
    fillDetails();
  }
  if (target.id === startScreen && previewMap) previewMap.map.invalidateSize();
}

// Кнопки з data-goto міняють адресу (#screen-map),
// тому кнопки «Назад/Вперед» у браузері працюють
document.querySelectorAll('[data-goto]').forEach((button) => {
  button.addEventListener('click', () => {
    location.hash = button.dataset.goto;
  });
});

// Реагуємо на зміну адреси: кнопка браузера «Назад», перехід, оновлення сторінки
window.addEventListener('hashchange', () => showScreen(location.hash.slice(1)));

// Вибір однієї кнопки в групі (ситуація, час доби, вулиця)
document.querySelectorAll('[data-group]').forEach((group) => {
  group.addEventListener('click', (event) => {
    const item = event.target.closest('button');
    if (!item) return;
    group.querySelectorAll('button').forEach((b) => b.classList.remove('is-selected'));
    item.classList.add('is-selected');
  });
});

// Мала карта на екрані 1 реагує на вибір ситуації й часу
document.querySelectorAll('#screen-situation [data-group]').forEach((group) => {
  group.addEventListener('click', () => {
    if (!previewMap) return;
    const c = currentChoice();
    previewMap.setProfile(c.profile);
    previewMap.setTimeOfDay(c.timeOfDay);
  });
});

// Повідомлення для кнопок з data-message
document.querySelectorAll('[data-message]').forEach((button) => {
  button.addEventListener('click', () => showToast(button.dataset.message));
});

// ---------- Кнопки карти ----------
document.getElementById('btn-route').addEventListener('click', startRouteFlow);

document.getElementById('btn-route-details').addEventListener('click', () => {
  pendingRoute = true;
  location.hash = 'screen-map';
});

document.querySelector('.search').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !szMap) return;
  const text = event.target.value.trim();
  if (!text) return;
  szMap.goToAddress(text).catch((err) => showToast(err.message));
});

// ---------- Старт ----------
showScreen(location.hash.slice(1));
initPreviewMap();
