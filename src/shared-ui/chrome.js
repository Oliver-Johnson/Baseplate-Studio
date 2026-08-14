/* Shared page furniture — runs on every page, tools and prose alike. */
(function () {
  /* Carry the working state across links that ask for it.
     The guide pages hold no state of their own, so following one and coming back
     used to throw away whatever layout you had. Anything marked data-carry passes
     the current hash straight through. */
  for (const a of document.querySelectorAll('a[data-carry]'))
    a.addEventListener('click', function (e) {
      if (!location.hash || location.hash.length < 3) return;
      e.preventDefault();
      location.href = a.getAttribute('href') + location.hash;
    });

  /* Tip jar. Persistent, but dismissible and it stays dismissed — a banner you
     cannot get rid of is worse than no banner. The flag is a local preference,
     not a tracker: nothing leaves the browser. */
  var bar = document.getElementById('kofi');
  if (!bar) return;
  try { if (localStorage.getItem('df-kofi') === 'off') bar.hidden = true; } catch (e) {}
  var x = document.getElementById('kofiX');
  if (x) x.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    bar.hidden = true;
    try { localStorage.setItem('df-kofi', 'off'); } catch (e2) {}
  });
})();
