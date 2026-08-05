'use strict';

/*
 * The CSS needed to rotate a full-screen player container.
 *
 * This looks trivial and is not, because rotating a box does NOT move it. The web player set
 * `width:100vh; height:100vw` and `rotate(90deg)` on a container pinned `inset: 0`, which leaves
 * the box in the top-left corner and spins it about ITS OWN centre — not the viewport's. On a
 * 1920x1080 panel that put the content 420px off-screen to the left and 420px off the bottom:
 * portrait content, correctly rotated, in the wrong place and cropped on two edges.
 *
 * The box has to be centred on the viewport BEFORE it is turned. Tizen already does this
 * (`top:50%; left:50%; translate(-50%,-50%) rotate()`), and Android does the equivalent with
 * translationX/Y offsets of (w-h)/2 — so the web player was the odd one out.
 *
 * Returned as plain style values so the same rule can be asserted in a test without a browser,
 * and shared rather than re-derived per player. Every property the rotated state sets is also
 * cleared by the landscape state: a half-reset leaves a container stuck at 100vh wide.
 */

const ROTATION_DEG = {
  'landscape': 0,
  'portrait': 90,
  'landscape-flipped': 180,
  'portrait-flipped': 270,
};

/**
 * @param {string} orientation  landscape | portrait | landscape-flipped | portrait-flipped
 * @returns {{transform:string,width:string,height:string,top:string,left:string,transformOrigin:string}}
 *          Values to assign directly onto element.style. Empty string means "clear it".
 */
function orientationStyle(orientation) {
  const deg = ROTATION_DEG[orientation];

  // Unknown orientation falls back to landscape rather than throwing: a bad value from the server
  // should leave a readable screen, not a blank or sideways one.
  if (!deg) {
    return { transform: '', width: '', height: '', top: '', left: '', transformOrigin: '' };
  }

  // 180 needs no dimension swap — the box already matches the viewport, it just turns over. Giving
  // it the portrait treatment would swap width and height for no reason and letterbox it.
  const swap = deg === 90 || deg === 270;
  if (!swap) {
    return {
      transform: 'rotate(180deg)',
      width: '', height: '', top: '', left: '',
      transformOrigin: 'center center',
    };
  }

  return {
    // translate BEFORE rotate: transforms apply right-to-left, so the box is turned about its own
    // centre and then that centre is moved onto the viewport's. Reversing them rotates the offset
    // as well and puts the content back off-screen.
    transform: 'translate(-50%, -50%) rotate(' + deg + 'deg)',
    width: '100vh',
    height: '100vw',
    top: '50%',
    left: '50%',
    transformOrigin: 'center center',
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { orientationStyle, ROTATION_DEG };
}
if (typeof window !== 'undefined') {
  window.OrientationStyle = { orientationStyle, ROTATION_DEG };
}
