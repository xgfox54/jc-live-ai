const sizes = ['100', '112.5', '125'];
const label = document.createElement('label'); label.className = 'display-size'; label.textContent = '표시 크기 ';
const select = document.createElement('select'); select.setAttribute('aria-label', '표시 크기');
for (const size of sizes) select.append(new Option(size + '%', size));
try { select.value = sizes.includes(localStorage.getItem('jc-display-size')) ? localStorage.getItem('jc-display-size') : '100'; } catch { select.value = '100'; }
const apply = () => { document.documentElement.style.fontSize = select.value + '%'; };
apply(); select.addEventListener('change', () => { apply(); try { localStorage.setItem('jc-display-size', select.value); } catch {} });
label.append(select); document.querySelector('header').append(label);
