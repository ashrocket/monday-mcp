#!/usr/bin/env node
// Trusted local CLI for the monday.com desktop debug endpoint. Run npm run build first.
// All commands share the package's origin checks, cross-process lock, and deadlines.
// The debug endpoint is unauthenticated: open it only while it is needed.
import { writeFileSync } from 'node:fs';
import {
  desktopTargets, desktopNavigate, desktopEvaluate, desktopScreenshot, withDesktop,
} from '../dist/desktop.js';

const options = {
  port: Number(process.env.PORT || '9222'),
  wsUrl: process.env.WS,
  expectedHost: process.env.MONDAY_ACCOUNT_SLUG
    ? `${process.env.MONDAY_ACCOUNT_SLUG}.monday.com` : undefined,
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  let result;
  switch (cmd) {
    case 'targets': result = await desktopTargets(options); break;
    case 'eval': result = await desktopEvaluate(options, args.join(' ')); break;
    case 'nav': result = await desktopNavigate(options, args[0]); break;
    case 'open': {
      const [slug, board, item] = args;
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug || '') ||
          !/^\d+$/.test(board || '') || !/^\d+$/.test(item || '')) {
        throw new Error('open needs an account slug and numeric board and item ids.');
      }
      result = await desktopNavigate(options, `https://${slug}.monday.com/boards/${board}/pulses/${item}`);
      break;
    }
    case 'shot': {
      const data = await desktopScreenshot(options);
      const file = args[0] || 'monday.png';
      writeFileSync(file, Buffer.from(data, 'base64'));
      result = { saved: file };
      break;
    }
    case 'click': {
      const [x, y] = args.map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
        throw new Error('click needs finite nonnegative x and y coordinates.');
      }
      await withDesktop(options, (session) => session.clickAt(x, y));
      result = { clicked: [x, y] };
      break;
    }
    default: throw new Error('commands: targets | eval <js> | nav <url> | open <slug> <board> <item> | shot <out.png> | click <x> <y>');
  }
  console.log(JSON.stringify(result, null, 2));
}

// The package has already released its lock and requested socket closure.
// A peer that withholds the close handshake must not keep this one-shot CLI alive.
main().then(() => process.exit(0)).catch((error) => { console.error(error.message); process.exit(1); });
