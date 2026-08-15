#!/usr/bin/env node
/* Which base styles stack on which, computed rather than asserted in a comment.
 *
 * Three styles exist and they are not freely interchangeable:
 *
 *   standard  spec foot (4.75 mm) + spec lip
 *   lowlip    spec foot (4.75 mm) + low lip, stopping at 2.0 mm with a flat rim
 *   low       short foot (2.0 mm) + low lip
 *
 * A short foot cannot enter a full lip. It runs out of taper at 2 mm, and above that
 * the bin is already at full width, so it fouls the lip wall and perches on top
 * instead of seating. That is the one combination that looks fine on screen, feels
 * fine in the hand, and leaves a stack standing 2 mm too tall and rocking.
 *
 * The test descends the upper bin's outer profile into the lower bin's lip opening
 * and reports the tightest clearance found anywhere up the lip.
 */
'use strict';
const {
  SPEC, BASE_STYLES, footProfile, lipHeight, BIN_DEFAULTS,
} = require('../src/bins/bin.js');

const lipMin = BIN_DEFAULTS.lipMin !== undefined ? BIN_DEFAULTS.lipMin : 0.55;

/* Inner half-width of a lip at height z above the top of the bin below. */
function lipInnerAt(style, z) {
  const st = BASE_STYLES[style];
  const lipH = st.lipH !== null ? st.lipH : lipHeight(lipMin);
  const rim = st.rim !== null ? st.rim : lipMin;
  const steps = st.lip.concat([[lipH, rim]]);
  if (z > lipH) return Infinity;                 // above the lip: nothing in the way
  for (let i = 0; i < steps.length - 1; i++) {
    const [z0, t0] = steps[i], [z1, t1] = steps[i + 1];
    if (z >= z0 && z <= z1) {
      const t = z1 > z0 ? t0 + (t1 - t0) * (z - z0) / (z1 - z0) : t0;
      return SPEC.half - t;
    }
  }
  return SPEC.half - steps[steps.length - 1][1];
}

/* Outer half-width of a bin at height z above its own base: the foot while the foot
   lasts, then the full body. The body is what fouls a lip a short foot cannot clear. */
function outerHalfAt(style, z) {
  const prof = footProfile(BASE_STYLES[style].footH);
  if (z >= prof[prof.length - 1][0]) return SPEC.half;
  for (let i = 0; i < prof.length - 1; i++) {
    const [z0, h0] = prof[i], [z1, h1] = prof[i + 1];
    if (z >= z0 && z <= z1) return z1 > z0 ? h0 + (h1 - h0) * (z - z0) / (z1 - z0) : h0;
  }
  return prof[0][1];
}

const STYLES = ['standard', 'lowlip', 'low'];
const lipHeightOf = (s) => {
  const st = BASE_STYLES[s];
  return st.lipH !== null ? st.lipH : lipHeight(lipMin);
};

function seat(upper, lower) {
  const lipH = lipHeightOf(lower);
  let worst = Infinity, worstAt = 0;
  for (let z = 0; z <= lipH + 1e-9; z += 0.01) {
    const clr = lipInnerAt(lower, z) - outerHalfAt(upper, z);
    if (clr < worst) { worst = clr; worstAt = z; }
  }
  return { worst, worstAt, lipH };
}

let bad = 0;
/* The pairs that must work, and the one that must not. */
const EXPECT = {
  'standard on standard': true, 'lowlip on standard': true, 'low on standard': false,
  'standard on lowlip': true, 'lowlip on lowlip': true, 'low on lowlip': true,
  'standard on low': true, 'lowlip on low': true, 'low on low': true,
};

console.log('upper bin seating into the lip of the bin below');
console.log('   upper      lower       lip mm   tightest clearance          verdict');
for (const lower of STYLES)
  for (const upper of STYLES) {
    const { worst, worstAt, lipH } = seat(upper, lower);
    const seats = worst > -1e-6;
    const key = `${upper} on ${lower}`;
    const ok = seats === EXPECT[key];
    if (!ok) bad++;
    console.log(`   ${upper.padEnd(10)} ${lower.padEnd(10)} ${lipH.toFixed(2).padStart(5)}   ` +
                `${worst.toFixed(3).padStart(7)} mm at z ${worstAt.toFixed(2)}   ` +
                `${seats ? 'seats' : 'FOULS — perches'}${ok ? '' : '   UNEXPECTED'}`);
  }

/* The stack the owner is printing: standard at the bottom, then lowlip, then low. */
console.log('\nthe three-bin test stack, bottom to top:');
{
  const order = ['standard', 'lowlip', 'low'];
  let z = 0, ok = true;
  for (let i = 0; i < order.length; i++) {
    const H = 1 * SPEC.unitH;                       // 1x1x1: one 7 mm unit each
    if (i > 0) {
      const r = seat(order[i], order[i - 1]);
      if (r.worst <= -1e-6) ok = false;
      console.log(`   ${order[i].padEnd(9)} onto ${order[i - 1].padEnd(9)} ` +
                  `clearance ${r.worst.toFixed(3)} mm   ${r.worst > -1e-6 ? 'seats' : 'FOULS'}`);
    } else {
      console.log(`   ${order[i].padEnd(9)} on the baseplate`);
    }
    z += H;
  }
  console.log(`   stack pitch ${z.toFixed(2)} mm plus the top bin's lip`);
  if (!ok) bad++;

  // and the order that does NOT work, so the failure is on the record too
  const wrong = seat('low', 'standard');
  console.log(`\n   for contrast, low straight onto standard: ${wrong.worst.toFixed(3)} mm ` +
              `at z ${wrong.worstAt.toFixed(2)} — ${wrong.worst > -1e-6 ? 'seats' : 'fouls, as intended'}`);
}

console.log(bad ? `\n${bad} pairing(s) did not behave as documented` : '\nstacking matches the documented rules');
process.exit(bad ? 1 : 0);
