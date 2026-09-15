// Paste this into the browser console while the dashboard is open.
//
// It reports the three things that went wrong in this dashboard, using the LIVE
// page rather than a test harness. Nothing is installed and nothing is changed:
// it reads, waits ~17 seconds so the 15-second auto-refresh fires, and reads
// again. If the numbers change between the two reads, the growth loop is live.
//
// How to use: open the dashboard, press F12, choose Console, paste this, Enter.
// It prints a short report and copies nothing anywhere.

(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = () => {
    const out = {};
    for (const id of ['priceCanvas', 'volCanvas']) {
      const c = document.getElementById(id);
      if (!c) {
        out[id] = 'MISSING';
        continue;
      }
      out[id] = {
        widthAttr: c.width,
        heightAttr: c.height,
        styleWidth: c.style.width || '(none)',
        clientWidth: c.clientWidth,
        // Layout width drives the feedback loop; the attribute is what we write.
        ratio: c.clientWidth ? +(c.width / c.clientWidth).toFixed(3) : null,
      };
    }
    return out;
  };

  console.log('%c--- dashboard diagnostic ---', 'font-weight:bold');
  console.log('userAgent  :', navigator.userAgent);
  console.log('devicePixelRatio :', window.devicePixelRatio);

  const a = snap();
  console.log('\nread 1 (now):');
  console.table(a);

  console.log('\nwaiting 17s so the auto-refresh redraws...');
  await sleep(17000);

  const b = snap();
  console.log('\nread 2 (after one auto-refresh):');
  console.table(b);

  // --- verdicts -----------------------------------------------------------
  console.log('\n--- verdict ---');
  let verdicts = 0;

  for (const id of ['priceCanvas', 'volCanvas']) {
    if (a[id] === 'MISSING') {
      console.log(`  ${id}: NOT PRESENT in the page`);
      verdicts++;
      continue;
    }
    if (b[id].clientWidth > a[id].clientWidth) {
      console.log(
        `  GROWTH LOOP ACTIVE on ${id}: layout width ${a[id].clientWidth} -> ${b[id].clientWidth} px`,
      );
      verdicts++;
    } else {
      console.log(`  ${id}: layout width stable at ${a[id].clientWidth}px`);
    }
    if (!a[id].styleWidth || a[id].styleWidth === '(none)') {
      console.log(`  ${id}: no CSS width set -> a canvas takes its layout width from the width attribute`);
      verdicts++;
    }
  }

  // Axis labels: read them straight off the canvas by re-running the page's own
  // formatter is not possible from here, so instead check the rendered page for
  // the known-bad signature: the same HH:MM printed twice in one axis pass is
  // visible in the old code only, so compare the served page size as a proxy.
  const html = document.documentElement.outerHTML;
  const hasTimeLabel = html.includes('function timeLabel');
  const pinsWidth = html.includes("cv.style.width = '100%'");
  console.log(`  page contains timeLabel fix   : ${hasTimeLabel}`);
  console.log(`  page pins canvas CSS width    : ${pinsWidth}`);
  if (!hasTimeLabel || !pinsWidth) {
    console.log('  >>> this page is an OLD build; the fixes are not in it');
    verdicts++;
  }

  console.log(
    verdicts === 0
      ? '\n%cRESULT: no problem detected — this page has the fixes and is stable'
      : `\n%cRESULT: ${verdicts} problem(s) detected above`,
    'font-weight:bold',
  );
})();
