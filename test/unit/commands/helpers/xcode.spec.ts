import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it, mock} from 'node:test';

import * as appiumXcodeModule from 'appium-xcode';
import * as teenProcessModule from 'teen_process';

// `appium-xcode` has a real `export default`, so its namespace object carries a `default` key.
// Spreading that into `namedExports` makes Node 22's module mocker emit `export let default = …`,
// which is a syntax error (`default` is reserved); Node 24 tolerates it. The key is dropped here
// because the helper only ever calls the named exports.
const appiumXcodeNamed = Object.fromEntries(Object.entries(appiumXcodeModule).filter(([key]) => key !== 'default'));

// The helper module is only imported after these mocks are registered, so its `exec` and
// `appium-xcode` bindings observe the fakes (see driver.spec.ts for the binding rules).
const IOS_SDK_VERSION = '18.4';
const TVOS_SDK_VERSION = '18.2';
const WATCHOS_SDK_VERSION = '26.5';

let iosSdkVersion: string | null = IOS_SDK_VERSION;
let tvosSdkVersion = TVOS_SDK_VERSION;
let xcrunCalls: string[][] = [];
let xcrunImpl: (args: string[]) => Promise<{stdout: string; stderr: string}> = async () => ({
  stdout: `${WATCHOS_SDK_VERSION}\n`,
  stderr: '',
});
let appiumXcodeFailures: {ios?: string; tvos?: string} = {};

/**
 * Stand-in for `appium-xcode`'s memoization of `getMaxTVOSSDK`: the real getter caches the promise it
 * returns, so a rejected one is replayed to every later caller until somebody clears the cache. The
 * fake has to behave the same way, otherwise a test of "a failed lookup is not replayed" would pass
 * no matter what the helper does.
 */
const tvosSdkCache = new Map<unknown, Promise<string>>();

const getMaxTVOSSDKStub = Object.assign(
  (retries?: number): Promise<string> => {
    const cached = tvosSdkCache.get(retries);
    if (cached) {
      return cached;
    }
    const lookup = (async () => {
      if (appiumXcodeFailures.tvos) {
        throw new Error(appiumXcodeFailures.tvos);
      }
      return tvosSdkVersion;
    })();
    tvosSdkCache.set(retries, lookup);
    return lookup;
  },
  {cache: tvosSdkCache},
);
mock.module('appium-xcode', {
  namedExports: {
    ...appiumXcodeNamed,
    getMaxIOSSDK: async () => {
      if (appiumXcodeFailures.ios) {
        throw new Error(appiumXcodeFailures.ios);
      }
      return iosSdkVersion;
    },
    getMaxTVOSSDK: getMaxTVOSSDKStub,
  },
});
mock.module('teen_process', {
  namedExports: {
    ...teenProcessModule,
    exec: async (cmd: string, args: string[] = []) => {
      xcrunCalls.push([cmd, ...args]);
      return await xcrunImpl(args);
    },
  },
});

const xcodeHelpers = await import('../../../../lib/commands/helpers/xcode.js');

describe('xcode helpers', function () {
  beforeEach(function () {
    iosSdkVersion = IOS_SDK_VERSION;
    tvosSdkVersion = TVOS_SDK_VERSION;
    appiumXcodeFailures = {};
    xcrunCalls = [];
    xcrunImpl = async () => ({stdout: `${WATCHOS_SDK_VERSION}\n`, stderr: ''});
    // the watchOS getter caches its promise for the whole process
    xcodeHelpers.getMaxWatchSdkVersion.cache.clear();
    // so does the memoised tvOS getter of `appium-xcode`
    tvosSdkCache.clear();
  });
  afterEach(function () {
    xcodeHelpers.getMaxWatchSdkVersion.cache.clear();
    tvosSdkCache.clear();
  });

  describe('getAndCheckMaxSdkVersion', function () {
    it('resolves the watchOS SDK via xcrun for watchOS sessions', async function () {
      assert.strictEqual(await xcodeHelpers.getAndCheckMaxSdkVersion('watchOS'), WATCHOS_SDK_VERSION);
      assert.deepStrictEqual(xcrunCalls, [['xcrun', '--sdk', 'watchsimulator', '--show-sdk-version']]);
    });

    it('accepts a watchOS platform name in any letter case', async function () {
      assert.strictEqual(await xcodeHelpers.getAndCheckMaxSdkVersion('watchos'), WATCHOS_SDK_VERSION);
      assert.deepStrictEqual(xcrunCalls, [['xcrun', '--sdk', 'watchsimulator', '--show-sdk-version']]);
    });

    it('queries xcrun only once for repeated watchOS lookups', async function () {
      assert.strictEqual(await xcodeHelpers.getAndCheckMaxSdkVersion('watchOS'), WATCHOS_SDK_VERSION);
      assert.strictEqual(await xcodeHelpers.getAndCheckMaxSdkVersion('watchOS'), WATCHOS_SDK_VERSION);
      assert.strictEqual(xcrunCalls.length, 1);
    });

    it('resolves the tvOS SDK for tvOS sessions without touching the watchsimulator SDK', async function () {
      assert.strictEqual(await xcodeHelpers.getAndCheckMaxSdkVersion('tvOS'), TVOS_SDK_VERSION);
      assert.deepStrictEqual(xcrunCalls, []);
    });

    it('resolves the iOS SDK for iOS sessions', async function () {
      assert.strictEqual(await xcodeHelpers.getAndCheckMaxSdkVersion('iOS'), IOS_SDK_VERSION);
      assert.deepStrictEqual(xcrunCalls, []);
    });

    it('falls back to the iOS SDK when no platform name is given', async function () {
      assert.strictEqual(await xcodeHelpers.getAndCheckMaxSdkVersion(undefined), IOS_SDK_VERSION);
      assert.strictEqual(await xcodeHelpers.getAndCheckMaxSdkVersion('macOS'), IOS_SDK_VERSION);
      assert.deepStrictEqual(xcrunCalls, []);
    });

    it('retries the watchsimulator query and reports the wrapped failure', async function () {
      xcrunImpl = async () => {
        throw Object.assign(new Error('Command failed with exit code 72'), {
          stderr: 'SDK "watchsimulator" cannot be located',
        });
      };

      await assert.rejects(
        () => xcodeHelpers.getAndCheckMaxSdkVersion('watchOS'),
        (err: Error) =>
          err.message.startsWith('Could not determine watchOS SDK version: Command failed with exit code 72') &&
          err.message.includes('SDK "watchsimulator" cannot be located'),
      );
      assert.strictEqual(xcrunCalls.length, 2);
    });

    it('does not cache a failed watchOS lookup for later sessions', async function () {
      xcrunImpl = async () => {
        throw Object.assign(new Error('xcrun is not installed'), {stderr: ''});
      };
      await assert.rejects(() => xcodeHelpers.getAndCheckMaxSdkVersion('watchOS'), /xcrun is not installed/);

      xcrunImpl = async () => ({stdout: `${WATCHOS_SDK_VERSION}\n`, stderr: ''});
      assert.strictEqual(await xcodeHelpers.getAndCheckMaxSdkVersion('watchOS'), WATCHOS_SDK_VERSION);
    });

    it('rejects a non-numeric watchsimulator SDK version', async function () {
      xcrunImpl = async () => ({stdout: '  \n', stderr: ''});

      await assert.rejects(
        () => xcodeHelpers.getAndCheckMaxSdkVersion('watchOS'),
        /Could not determine watchOS SDK version: xcrun returned a non-numeric watchsimulator SDK version: ''/,
      );
    });

    it('reports a tvOS SDK lookup failure with the tvOS platform name', async function () {
      appiumXcodeFailures.tvos = 'xcrun returned a non-numeric tvOS SDK version';

      await assert.rejects(
        () => xcodeHelpers.getAndCheckMaxSdkVersion('tvOS'),
        /Could not determine tvOS SDK version: xcrun returned a non-numeric tvOS SDK version/,
      );
    });

    // `appium-xcode` memoizes the getter, so the rejected promise of one transient `xcrun` failure
    // would otherwise be replayed to every later session of a long-lived server, even after the SDK
    // has become available again.
    it('does not cache a failed tvOS lookup for later sessions', async function () {
      appiumXcodeFailures.tvos = 'xcrun is not installed';
      await assert.rejects(() => xcodeHelpers.getAndCheckMaxSdkVersion('tvOS'), /xcrun is not installed/);

      appiumXcodeFailures = {};
      assert.strictEqual(await xcodeHelpers.getAndCheckMaxSdkVersion('tvOS'), TVOS_SDK_VERSION);
    });

    it('reports an iOS SDK lookup failure with the iOS platform name', async function () {
      appiumXcodeFailures.ios = 'no iOS SDKs';

      await assert.rejects(
        () => xcodeHelpers.getAndCheckMaxSdkVersion('iOS'),
        /Could not determine iOS SDK version: no iOS SDKs/,
      );
    });
  });
});
