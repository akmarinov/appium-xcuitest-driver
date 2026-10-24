import assert from 'node:assert/strict';
import {describe, it, before, beforeEach, afterEach} from 'node:test';

import {WATCHOS_CAPS, WATCHOS_DEVICE_NAME} from '../desired.js';
import {PREDICATE_SEARCH, CLASS_CHAIN_SEARCH} from '../helpers/element.js';
import {initSession, deleteSession} from '../helpers/session.js';
import {getTargetDevice} from '../helpers/simulator.js';

const WATCH_APP_ID = 'com.apple.NanoSettings';

/**
 * Reads the pixel dimensions out of a PNG's IHDR chunk.
 *
 * @throws {AssertionError} If the payload is not a PNG at all
 */
function pngDimensions(payload: Buffer): {width: number; height: number} {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(
    payload.subarray(0, 8).equals(PNG_SIGNATURE),
    'the screenshot is not a PNG: the driver is routing the capture to something else',
  );
  return {width: payload.readUInt32BE(16), height: payload.readUInt32BE(20)};
}

/**
 * What `mobile: activeAppInfo` answers, narrowed to the fields asserted here. webdriverio types
 * `execute` as resolving to an element reference, so each call is assigned to this shape once and
 * its fields are then read through the named const.
 */
type ActiveAppInfo = {bundleId: string; pid: number};

/**
 * watchOS sessions here drive `com.apple.NanoSettings`, the watch application shipped with the
 * Simulator, so these tests cover the driver and the agent CI installs rather than an app of ours.
 *
 * Only behaviour that holds against *upstream's* published WebDriverAgent belongs in this file: the
 * CI job downloads a prebuilt watchOS agent release asset (`functional-test.yml` runs
 * `appium driver run xcuitest download-wda --platform=watchOS`) rather than building a branch, so a
 * test gated on an unpublished agent build would fail the whole matrix. Behaviours that need a newer
 * agent - refusing a `mobile: swipe` `velocity`, dismissing the keyboard through the watch accessory
 * bar, and answering `no such alert` instead of an empty alert body for the permanent childless
 * `XCUIElementTypeAlert` watchOS keeps in the system application - are covered by the agent's own
 * integration suite and by the repeatable scripts described in the plan document.
 */
describe('watchOS', function () {
  let baseCaps: Record<string, any>;
  let udid: string;

  before(async function () {
    udid = await getTargetDevice(WATCHOS_DEVICE_NAME);
  });

  beforeEach(function () {
    baseCaps = {...WATCHOS_CAPS, udid};
  });

  afterEach(async function () {
    await deleteSession();
  });

  it('should launch com.apple.NanoSettings', async function () {
    const driver = await initSession(baseCaps);
    // A webdriverio element is truthy whether or not it exists, so existence has to be asked for.
    // If the application is not running, the watch shows its face instead and every test below
    // would query the wrong UI.
    assert.ok(await (await driver.$('~General')).isExisting(), "'General' is not present in NanoSettings");
  });

  it('should report the watch application as active', async function () {
    const driver = await initSession(baseCaps);
    const activeAppInfo = (await driver.execute('mobile: activeAppInfo')) as unknown as ActiveAppInfo;
    // The watch application, not its iPhone companion and not the system app.
    assert.equal(activeAppInfo.bundleId, WATCH_APP_ID);
    assert.ok(activeAppInfo.pid > 0, `expected a live pid, got ${activeAppInfo.pid}`);
  });

  it('should expose the accessibility hierarchy and element metrics', async function () {
    const driver = await initSession(baseCaps);

    const source = await driver.getPageSource();
    assert.match(source, /XCUIElementTypeApplication/);
    assert.match(source, /General/);

    const element = await driver.$('~General');
    assert.ok(await element.isExisting());
    assert.ok(await element.isDisplayed());
    assert.equal(await element.getText(), 'General');
    // NanoSettings renders its labels as StaticText, not Button.
    assert.equal(await element.getTagName(), 'XCUIElementTypeStaticText');

    const size = await element.getSize();
    assert.ok(size.width > 0 && size.height > 0, `unexpected size ${JSON.stringify(size)}`);

    const rect = await driver.getWindowRect();
    assert.ok(rect.width > 0 && rect.height > 0, `unexpected window ${JSON.stringify(rect)}`);

    // Any finite number passes a `Number.isFinite` check, including geometry the metrics layer
    // invented. Containment is not the invariant: a displayed row in a scrolling watch list is
    // legitimately clipped by the panel (measured here: `General` sits at y=247 with height 24 in a
    // 248pt window). What a displayed element *must* satisfy is that its own rectangle overlaps the
    // window it is displayed in - a positive intersection area - because that is the only geometry
    // the user can see. Off-panel coordinates, negative origins, or metrics taken from another
    // display all fail it while the clipped row passes.
    const location = await element.getLocation();
    const overlapWidth = Math.min(location.x + size.width, rect.width) - Math.max(location.x, 0);
    const overlapHeight = Math.min(location.y + size.height, rect.height) - Math.max(location.y, 0);
    assert.ok(
      overlapWidth > 0 && overlapHeight > 0,
      `'General' at ${JSON.stringify(location)} + ${JSON.stringify(size)} does not overlap the ` +
        `visible window ${JSON.stringify(rect)} (overlap ${overlapWidth}x${overlapHeight})`,
    );

    // A blank frame is still hundreds of bytes, so a length threshold proves nothing. The image has
    // to be a PNG of the panel: a capture routed to the wrong display, or one the platform refuses,
    // arrives as a different payload or a different geometry. WatchOS renders at 2x the window's
    // points, so the pixel size is a whole multiple of the window with the same aspect.
    const shot = pngDimensions(Buffer.from(await driver.takeScreenshot(), 'base64'));
    assert.ok(shot.width > 0 && shot.height > 0, `empty screenshot frame ${JSON.stringify(shot)}`);
    for (const [pixels, points] of [
      [shot.width, rect.width],
      [shot.height, rect.height],
    ] as const) {
      assert.equal(pixels % points, 0, `a ${pixels}px frame is not an integer multiple of a ${points}pt window`);
    }
    assert.ok(
      Math.abs(shot.width / shot.height - rect.width / rect.height) < 0.02,
      `a ${shot.width}x${shot.height} screenshot does not match the ${rect.width}x${rect.height} window`,
    );
  });

  // `isExisting()` on four locators passes even when all four resolve to four *different* elements:
  // it only proves each query matched something. Comparing the resolved element identifiers proves
  // every strategy reaches the same node, which is what a locator strategy matrix has to guarantee.
  it('should find the same element with every supported locator strategy', async function () {
    const driver = await initSession(baseCaps);
    const tagName = await (await driver.$('~General')).getTagName();

    /** The identifiers webdriverio hands back for a locator, in document order. */
    const idsFor = async (locator: string): Promise<string[]> => {
      const ids: string[] = [];
      for (const element of await driver.$$(locator)) {
        ids.push(await element.elementId);
      }
      return ids;
    };

    // The element every other strategy is expected to reach.
    const byAccessibilityId = await idsFor('~General');
    assert.equal(byAccessibilityId.length, 1, `'~General' resolved ${JSON.stringify(byAccessibilityId)}`);
    const reference = byAccessibilityId[0];

    // One match each, and it has to be the reference.
    for (const locator of [
      `${CLASS_CHAIN_SEARCH}:**/${tagName}[\`name == 'General'\`]`,
      `${PREDICATE_SEARCH}:name == 'General' AND type == '${tagName}'`,
      `xpath://${tagName}[@name='General']`,
    ]) {
      const ids = await idsFor(locator);
      assert.deepEqual(ids, [reference], `'${locator}' resolved ${JSON.stringify(ids)} instead of ${reference}`);
    }

    // Every StaticText, so this one is only required to contain the label.
    assert.ok(
      (await idsFor(`class name:${tagName}`)).includes(reference),
      'the class name strategy must include the label among its matches',
    );
  });

  it('should rotate the Digital Crown and press the home button', async function () {
    const driver = await initSession(baseCaps);
    // wdio types `execute` as resolving to an element reference; this command answers an object.
    const beforeInfo = (await driver.execute('mobile: activeAppInfo')) as unknown as ActiveAppInfo;

    await driver.execute('mobile: rotateDigitalCrown', {delta: 5});
    await driver.execute('mobile: rotateDigitalCrown', {delta: -5});

    // A page source that still names an application only proves *something* answered. A watch agent
    // whose runner dies mid-synthesis is restarted by the platform and the session keeps serving
    // requests against a fresh agent - so the observable hazard is the application losing its
    // process, not the response failing. The same live pid afterwards says the rotation neither
    // killed nor restarted what it was driving.
    const after = (await driver.execute('mobile: activeAppInfo')) as unknown as ActiveAppInfo;
    assert.equal(after.bundleId, WATCH_APP_ID);
    assert.equal(after.pid, beforeInfo.pid, 'the application under test changed process across the rotation');
    // And the element tree is still queryable through the same session.
    assert.match(await driver.getPageSource(), /XCUIElementTypeApplication/);

    // The home button is the command most likely to end the session, so it runs last.
    await driver.execute('mobile: pressButton', {name: 'home'});
    assert.match(await driver.getPageSource(), /XCUIElementTypeApplication/);
  });

  it('should reject unsupported capabilities naming the platform and the reason', async function () {
    const driver = await initSession(baseCaps);
    const commands: [string, () => Promise<unknown>][] = [
      ['mobile: keys', () => driver.execute('mobile: keys', {keys: ['a']})],
      ['mobile: setClipboard', () => driver.execute('mobile: setClipboard', {content: 'aGk=', encoding: 'base64'})],
      ['mobile: pinch', () => driver.execute('mobile: pinch', {scale: 1.5, velocity: 2})],
      ['mobile: forcePress', () => driver.execute('mobile: forcePress', {duration: 0.5})],
      ['mobile: deepLink', () => driver.execute('mobile: deepLink', {url: 'https://appium.io'})],
      ['orientation', () => driver.getOrientation()],
      ['orientation', () => driver.setOrientation('LANDSCAPE')],
    ];
    for (const [label, call] of commands) {
      await assert.rejects(
        call,
        (err: Error) => {
          assert.match(err.message, /not supported on watchOS/);
          return true;
        },
        `${label} should be rejected naming watchOS and the reason`,
      );
    }
  });

  it('should keep application lifecycle commands working', async function () {
    const driver = await initSession(baseCaps);
    // wdio types `execute` as resolving to an element reference; this command answers a number.
    const appState = async () =>
      (await driver.execute('mobile: queryAppState', {bundleId: WATCH_APP_ID})) as unknown as number;

    assert.equal(await driver.isAppInstalled(WATCH_APP_ID), true);
    assert.equal(await appState(), 4); // 4 == running in the foreground

    await driver.execute('mobile: terminateApp', {bundleId: WATCH_APP_ID});
    assert.equal(await appState(), 1); // 1 == not running

    await driver.execute('mobile: activateApp', {bundleId: WATCH_APP_ID});
    await driver.waitUntil(async () => (await appState()) === 4, {
      timeoutMsg: 'the watch application never returned to the foreground',
    });
  });

  it('should report stale elements after the application is terminated', async function () {
    const driver = await initSession(baseCaps);
    const element = await driver.$('~General');
    assert.ok(await element.isDisplayed());

    await driver.execute('mobile: terminateApp', {bundleId: WATCH_APP_ID});
    // A handle held across termination must be reported gone rather than answered with data from a
    // relaunched application, and must not time out.
    await assert.rejects(
      () => element.getText(),
      (err: Error) => {
        assert.match(err.message, /not present in the current view anymore/);
        return true;
      },
      'a reference held across termination should be reported stale',
    );

    await driver.execute('mobile: activateApp', {bundleId: WATCH_APP_ID});
    assert.ok(await (await driver.$('~General')).isDisplayed());
  });
});
