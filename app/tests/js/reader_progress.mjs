// The reader's progress writes to Kavita (pages/reader.js progressWriter),
// with answers arriving late, failing and out of order. One write is in
// flight at a time, so the page Kavita is known to hold is the page it last
// took, never an older write answered late.
//
// Imports reader.js as it is, through a data: URL like router.mjs (a module
// in a folder with no package.json "type"); that also proves the module
// touches no DOM at import time.
// Run: node app/tests/js/reader_progress.mjs (npm run test:js).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../static/js/pages/reader.js'), 'utf8');
const { progressWriter } = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));

let failed = 0;
let total = 0;
function check(what, ok, detail) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${what}` + (detail === undefined ? '' : `: ${JSON.stringify(detail)}`));
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
// The writes are queued per book, for the whole document (every visit's
// writer for a book shares one queue): each case below uses a book of its own.
let books = 0;
const book = () => 'test-book-' + (++books);

// A Kavita whose answers the test hands out, in any order.
function fakeKavita() {
  const k = { sent: [], open: [], most: 0, inFlight: 0 };
  k.send = function (page) {
    k.sent.push(page);
    k.inFlight += 1;
    k.most = Math.max(k.most, k.inFlight);
    return new Promise((resolve, reject) => {
      k.open.push({
        page,
        answer(ok) { k.inFlight -= 1; resolve(ok); },
        fail() { k.inFlight -= 1; reject(new Error('network')); }
      });
    });
  };
  k.take = (page) => k.open.splice(k.open.findIndex((o) => o.page === page), 1)[0];
  return k;
}

if (typeof progressWriter !== 'function') {
  check('reader.js exports progressWriter', false);
} else {
  // Page 5's write is slow; the reader turns to 6 meanwhile. 6 must not go
  // while 5 is in flight, so the answers cannot cross.
  {
    const k = fakeKavita();
    const w = progressWriter(k.send, book());
    w.write(5);
    w.write(6);
    check('a second write waits for the first', JSON.stringify(k.sent) === '[5]', k.sent);
    k.take(5).answer(true);
    await tick(); await tick();
    check('the waiting page goes once the first answers', JSON.stringify(k.sent) === '[5,6]', k.sent);
    check('confirmed follows the page Kavita took (5)', w.confirmed === 5, w.confirmed);
    k.take(6).answer(true);
    await tick(); await tick();
    check('confirmed is the newest page taken (6)', w.confirmed === 6, w.confirmed);
    check('never two writes in flight', k.most === 1, k.most);
  }

  // The regression case: without the one-at-a-time rule, 6 answered first
  // and 5's late answer then set confirmed back to 5. Here 5's answer comes
  // in last of all, and confirmed still ends on the newest page taken.
  {
    const k = fakeKavita();
    const w = progressWriter(k.send, book());
    w.write(5);
    w.write(6);
    w.write(7);
    check('only the newest waiting page is kept', JSON.stringify(k.sent) === '[5]', k.sent);
    k.take(5).answer(true);
    await tick(); await tick();
    check('turns while a write is in flight collapse to the newest', JSON.stringify(k.sent) === '[5,7]', k.sent);
    k.take(7).answer(true);
    await tick(); await tick();
    check('confirmed never goes back to an older page', w.confirmed === 7, w.confirmed);
  }

  // A write Kavita refused, or that failed on the network, confirms nothing,
  // and the one waiting still goes.
  {
    const k = fakeKavita();
    const w = progressWriter(k.send, book());
    w.known(2);
    w.write(3);
    w.write(4);
    k.take(3).answer(false);
    await tick(); await tick();
    check('a refused write confirms nothing', w.confirmed === 2, w.confirmed);
    check('the waiting page goes after a refusal', JSON.stringify(k.sent) === '[3,4]', k.sent);
    k.take(4).fail();
    await tick(); await tick();
    check('a failed write confirms nothing', w.confirmed === 2, w.confirmed);
    w.write(4);
    check('a failed page can be written again', JSON.stringify(k.sent) === '[3,4,4]', k.sent);
  }

  // The page waiting is dropped when Kavita already holds it by the time
  // its turn comes.
  {
    const k = fakeKavita();
    const w = progressWriter(k.send, book());
    w.write(8);
    w.write(8);
    k.take(8).answer(true);
    await tick(); await tick();
    check('a waiting page Kavita now holds is not sent again', JSON.stringify(k.sent) === '[8]', k.sent);
  }

  // The leave beacon: it carries the visit's last page, so nothing waiting
  // goes after it, and confirmed is that page.
  {
    const k = fakeKavita();
    const w = progressWriter(k.send, book());
    w.write(10);
    w.write(11);
    w.sent(12);
    k.take(10).answer(false);
    await tick(); await tick();
    check('nothing waiting goes after the beacon', JSON.stringify(k.sent) === '[10]', k.sent);
    check('the beacon page is confirmed', w.confirmed === 12, w.confirmed);
  }

  // Fix round 2. A soft-navigation leave: the document keeps running, so the
  // final save waits for the write in flight and goes after it (keepalive,
  // not bound to the page), and lands last. Nothing is sent after it.
  if (typeof progressWriter(() => true, book()).leave !== 'function') {
    check('the writer has a soft-leave save (leave)', false);
  } else {
    {
      const k = fakeKavita();
      const w = progressWriter(k.send, book());
      w.write(10);
      const done = w.leave(12);
      check('the final save waits for the write in flight', JSON.stringify(k.sent) === '[10]', k.sent);
      k.take(10).answer(true);
      await tick(); await tick();
      check('then goes, after it', JSON.stringify(k.sent) === '[10,12]', k.sent);
      check('never two writes in flight, the final save included', k.most === 1, k.most);
      k.take(12).answer(true);
      await done;
      check('the final save is what Kavita holds', w.confirmed === 12, w.confirmed);
      w.write(13);
      check('nothing is sent after the final save', JSON.stringify(k.sent) === '[10,12]', k.sent);
    }
    {
      // The final save's answer comes back; an in-flight write that failed
      // or was refused changes nothing, and the final save still goes.
      const k = fakeKavita();
      const w = progressWriter(k.send, book());
      w.write(4);
      w.write(5);                      // waiting: the final save carries the newest instead
      w.leave(6);
      k.take(4).fail();
      await tick(); await tick();
      check('a failed write in flight still lets the final save go, and the waiting page is dropped',
        JSON.stringify(k.sent) === '[4,6]', k.sent);
    }
    {
      // Nothing to save: Kavita already holds the page, nothing in flight.
      const k = fakeKavita();
      const w = progressWriter(k.send, book());
      w.known(7);
      await w.leave(7);
      check('no final save when Kavita holds the page', k.sent.length === 0, k.sent);
      const k2 = fakeKavita();
      const w2 = progressWriter(k2.send, book());
      w2.known(7);
      w2.leave(8);
      await tick(); await tick();
      check('with nothing in flight the final save goes at once', JSON.stringify(k2.sent) === '[8]', k2.sent);
    }
    {
      // The write in flight turns out to be the page being left on.
      const k = fakeKavita();
      const w = progressWriter(k.send, book());
      w.write(9);
      w.leave(9);
      k.take(9).answer(true);
      await tick(); await tick(); await tick();
      check('no final save when the write in flight was the page', JSON.stringify(k.sent) === '[9]', k.sent);
    }
  }

  // A hard exit (tab hidden or closed): the beacon carries the newest page
  // and counts as the newest send. The write in flight answering true
  // afterwards is older, and is ignored (the case the reviewer reproduced:
  // write(10) in flight, beacon 12, 10 answers true: confirmed must stay 12).
  {
    const k = fakeKavita();
    const w = progressWriter(k.send, book());
    w.write(10);
    w.sent(12);
    check('the beacon page is confirmed at once', w.confirmed === 12, w.confirmed);
    k.take(10).answer(true);
    await tick(); await tick();
    check('an older write answering true after the beacon is ignored', w.confirmed === 12, w.confirmed);
    // Reading goes on (the tab came back): the writer still writes.
    w.write(13);
    check('the writer goes on after a beacon', k.sent[k.sent.length - 1] === 13, k.sent);
  }

  // confirmed moves forward in send order only.
  {
    const k = fakeKavita();
    const w = progressWriter(k.send, book());
    w.write(3);
    w.sent(4);                          // newer send, confirmed 4
    w.write(5);                         // waits for 3
    k.take(3).answer(true);             // older: ignored
    await tick(); await tick();
    check('a late true from an older write after a newer confirm is ignored', w.confirmed === 4, w.confirmed);
    k.take(5).answer(true);
    await tick(); await tick();
    check('a newer write still confirms', w.confirmed === 5, w.confirmed);
  }

  // Fix round 3: one queue per book for the whole document, across visits.
  // The reviewer's probe: visit 1 leaves on page 40 while Kavita is slow
  // (200 ms); the book is reopened and visit 2 writes page 2, answered in
  // 5 ms. Visit 2's write waits for visit 1's, and Kavita ends on page 2.
  {
    let kavitaHolds = null;
    const order = [];
    const slow = (ms) => (page) => new Promise((r) => setTimeout(() => { kavitaHolds = page; order.push(page); r(true); }, ms));
    const id = book();
    const w1 = progressWriter(slow(200), id);
    w1.write(40);
    w1.leave(40);
    const w2 = progressWriter(slow(5), id);
    w2.write(2);
    await new Promise((r) => setTimeout(r, 400));
    check('two visits of one book: Kavita ends on the newer visit\'s page', kavitaHolds === 2, { kavitaHolds, order });
    check('two visits of one book: the older write lands first', order.join() === '40,2', order);
    check('two visits of one book: confirmed is the newer page', w2.confirmed === 2, w2.confirmed);
  }

  // The same, with the answers handed out by the test: visit 2's write is
  // not even sent until visit 1's leave-save has answered.
  {
    const k = fakeKavita();
    const id = book();
    const w1 = progressWriter(k.send, id);
    w1.write(30);
    w1.leave(31);
    const w2 = progressWriter(k.send, id);
    w2.write(3);
    check('a reopened book\'s write waits behind the last visit\'s', JSON.stringify(k.sent) === '[30]', k.sent);
    k.take(30).answer(true);
    await tick(); await tick();
    check('then the last visit\'s leave-save', JSON.stringify(k.sent) === '[30,31]', k.sent);
    k.take(31).answer(true);
    await tick(); await tick();
    check('then the new visit\'s write', JSON.stringify(k.sent) === '[30,31,3]', k.sent);
    check('never two writes for one book in flight, across visits', k.most === 1, k.most);
    k.take(3).answer(true);
    await tick(); await tick();
    check('confirmed follows the newest send across visits', w2.confirmed === 3, w2.confirmed);
  }

  // Two books do not wait for each other.
  {
    const k = fakeKavita();
    const a = progressWriter(k.send, book());
    const b = progressWriter(k.send, book());
    a.write(1);
    b.write(9);
    check('another book\'s write goes at once', JSON.stringify(k.sent) === '[1,9]', k.sent);
    k.take(1).answer(true);
    k.take(9).answer(true);
    await tick(); await tick();
    check('each book keeps its own confirmed page', a.confirmed === 1 && b.confirmed === 9, [a.confirmed, b.confirmed]);
  }

  // Reopened while the last visit's leave-save is still pending, then left
  // again: every save goes in order and the newest lands last. A visit's
  // settled() is the book's queue running dry (the reader waits for it
  // before it asks Kavita where the reader is).
  {
    const k = fakeKavita();
    const id = book();
    const w1 = progressWriter(k.send, id);
    w1.write(10);
    w1.leave(12);
    const w2 = progressWriter(k.send, id);
    let dry = false;
    w2.settled().then(() => { dry = true; });
    w2.leave(15);
    k.take(10).answer(true);
    await tick(); await tick();
    k.take(12).answer(true);
    await tick(); await tick();
    check('the reopened visit\'s leave waits its turn', JSON.stringify(k.sent) === '[10,12,15]', k.sent);
    check('settled waits for every write queued before it', dry === true, dry);
    k.take(15).answer(true);
    await tick(); await tick();
    check('the newest leave is what Kavita holds', w2.confirmed === 15, w2.confirmed);
  }

  // A hard exit's beacon supersedes a write still waiting its turn in the
  // book's queue: it is not sent after the beacon.
  {
    const k = fakeKavita();
    const id = book();
    const w1 = progressWriter(k.send, id);
    w1.write(20);
    const w2 = progressWriter(k.send, id);
    w2.write(21);                     // queued behind 20
    w2.sent(22);                      // hard exit: the beacon carried 22
    k.take(20).answer(true);
    await tick(); await tick(); await tick();
    check('a write queued before a beacon is not sent after it', JSON.stringify(k.sent) === '[20]', k.sent);
    check('the beacon page stays confirmed', w2.confirmed === 22, w2.confirmed);
  }

  // send may throw, or answer synchronously: neither jams the writer.
  {
    const w = progressWriter(() => { throw new Error('boom'); }, book());
    w.write(1);
    await tick(); await tick();
    check('a throwing send confirms nothing', w.confirmed === -1, w.confirmed);
    const sent = [];
    const w2 = progressWriter((p) => { sent.push(p); return p !== 1; }, book());
    w2.write(1);
    w2.write(2);
    await tick(); await tick(); await tick();
    check('a plain true/false answer works and the queue moves on', w2.confirmed === 2 && sent.join() === '1,2', [w2.confirmed, sent]);
  }
}

console.log(`${total - failed}/${total} reader progress cases pass`);
process.exit(failed ? 1 : 0);
