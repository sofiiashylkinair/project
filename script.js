const screens = document.querySelectorAll('.screen');
const startScreen = 'screen-situation';

// Показуємо екран за id
function showScreen(id) {
  const target = document.getElementById(id) || document.getElementById(startScreen);
  screens.forEach((screen) => screen.classList.remove('is-active'));
  target.classList.add('is-active');
  window.scrollTo(0, 0);
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
showScreen(location.hash.slice(1));

// Вибір однієї кнопки в групі (ситуація, час доби, вулиця)
document.querySelectorAll('[data-group]').forEach((group) => {
  group.addEventListener('click', (event) => {
    const item = event.target.closest('button');
    if (!item) return;
    group.querySelectorAll('button').forEach((b) => b.classList.remove('is-selected'));
    item.classList.add('is-selected');
  });
});

// Коротке повідомлення для кнопок з data-message
const toast = document.getElementById('toast');
let toastTimer;

document.querySelectorAll('[data-message]').forEach((button) => {
  button.addEventListener('click', () => {
    toast.textContent = button.dataset.message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2000);
  });
});
