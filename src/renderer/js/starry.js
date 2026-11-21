// "Starry Night" theme: a night sky behind the app, with twinkling stars and shooting stars.
// Based on the StarryNight Spicetify theme by b-chen00 (https://github.com/b-chen00/spicetify-themes, MIT license).
// The shooting stars come from "Pure CSS Shooting Star Animation Effect", Copyright (c) 2021 by Delroy Prithvi
// (https://codepen.io/delroyprithvi/pen/LYyJROR), MIT license: see the notice in styles.css.

// The themes in Settings → Appearance. swatch: the little preview tile (CSS background); sparkle: draw the
// Starry Night icon on it.
const THEMES = [
  { id: 'dark', name: 'Dark', swatch: '#121214' },
  { id: 'black', name: 'Black (AMOLED)', swatch: '#000000' },
  { id: 'light', name: 'Light', swatch: '#f6f6f8' },
  { id: 'starry', name: 'Starry Night', swatch: 'linear-gradient(180deg, #000000 0%, #142b44 100%)', sparkle: true },
];
const STARRY_ACCENT = '#fff3c4';

const StarrySky = {
  el: null,
  resizeTimer: null,

  // Shown while the Starry Night theme is on, removed otherwise.
  toggle(on) {
    if (on && !this.el) this.start();
    else if (!on && this.el) this.stop();
  },

  start() {
    this.el = h('div', { id: 'starry-sky', 'aria-hidden': 'true' });
    document.body.prepend(this.el);
    this.fill();
    this.onResize = () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.el && this.fill(), 300);
    };
    window.addEventListener('resize', this.onResize);
  },

  stop() {
    window.removeEventListener('resize', this.onResize);
    clearTimeout(this.resizeTimer);
    this.el.remove();
    this.el = null;
  },

  // One star per 4000 square pixels of window; a fifth of them twinkle. Four shooting stars keep coming back.
  fill() {
    const rand = (min, max) => Math.random() * (max - min) + min;
    const frag = document.createDocumentFragment();
    const count = Math.round((window.innerWidth * window.innerHeight) / 4000);
    for (let i = 0; i < count; i++) {
      const size = Math.random() < 0.5 ? 1 : 2;
      const star = h('div', { class: 'star' });
      star.style.cssText = `left:${rand(0, 99)}%;top:${rand(0, 99)}%;width:${size}px;height:${size}px;opacity:${rand(0.5, 1).toFixed(2)}`;
      if (Math.random() < 1 / 5) star.style.animation = `starry-twinkle${Math.floor(Math.random() * 4) + 1} 5s infinite`;
      frag.append(star);
    }
    const place = (s) => {
      // Mostly from the top edge, sometimes from the right; hidden just outside the window while waiting.
      if (Math.random() < 0.75) {
        s.style.top = '-4px';
        s.style.right = `${rand(0, 90)}%`;
      } else {
        s.style.top = `${rand(0, 50)}%`;
        s.style.right = '-4px';
      }
    };
    for (let i = 0; i < 4; i++) {
      const s = h('span', { class: 'shooting-star' });
      place(s);
      s.style.animationDuration = `${Math.floor(Math.random() * 3) + 3}s`;
      s.style.animationDelay = `${Math.floor(Math.random() * 7)}s`;
      s.addEventListener('animationend', () => {
        place(s);
        s.style.animation = 'none';
        void s.offsetWidth; // restart the animation
        s.style.animation = '';
        s.style.animationDuration = `${Math.floor(Math.random() * 4) + 3}s`;
      });
      frag.append(s);
    }
    this.el.replaceChildren(frag);
  },
};
