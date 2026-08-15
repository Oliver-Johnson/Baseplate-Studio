/* Shared page furniture — runs on every page, tools and prose alike. */
(function () {
  /* Carry the working state across links that ask for it.
     The guide pages hold no state of their own, so following one and coming back
     used to throw away whatever layout you had. Anything marked data-carry passes
     the current hash straight through. */
  var links = document.querySelectorAll('a[data-carry]');
  if (document.body.hasAttribute('data-carry-all')) {
    // every internal link on a prose page carries: hub to spoke, spoke to spoke and
    // back to the tools. Marking them individually meant one missed link threw the
    // layout away, which is exactly what happened with the guide cross-links.
    links = [].filter.call(document.querySelectorAll('a[href]'), function (a) {
      var h = a.getAttribute('href') || '';
      return h && !/^(https?:|mailto:|#)/.test(h);
    });
  }
  for (const a of links)
    a.addEventListener('click', function (e) {
      if (!location.hash || location.hash.length < 3) return;
      e.preventDefault();
      location.href = a.getAttribute('href') + location.hash;
    });

  /* Full-screen preview.
     On a touch screen the 3D preview was unusable: dragging a finger across it
     scrolled the page instead of rotating the model, because the canvas has to let
     the page scroll or you could never scroll past it. Rather than trade one for the
     other, expanding it makes the choice explicit — full screen, page scrolling
     locked, and touch-action off the canvas so a drag rotates. Escape or the button
     puts it back. Both tools resize their renderer from a window resize event, so
     one dispatch covers them. */
  var wrap = document.getElementById('threewrap');
  if (wrap) {
    var btn = document.createElement('button');
    btn.className = 'previewbtn';
    btn.type = 'button';
    btn.title = 'Expand the preview';
    btn.setAttribute('aria-label', 'Expand the preview');
    btn.textContent = 'Expand';
    wrap.appendChild(btn);

    var setExpanded = function (on) {
      wrap.classList.toggle('expanded', on);
      document.body.classList.toggle('previewlock', on);
      btn.textContent = on ? 'Close' : 'Expand';
      btn.title = on ? 'Close the preview' : 'Expand the preview';
      btn.setAttribute('aria-label', btn.title);
      // let the page settle at its new size before the renderer measures it
      requestAnimationFrame(function () { window.dispatchEvent(new Event('resize')); });
    };
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      setExpanded(!wrap.classList.contains('expanded'));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && wrap.classList.contains('expanded')) setExpanded(false);
    });
  }

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
