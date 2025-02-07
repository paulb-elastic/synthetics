/**
 * MIT License
 *
 * Copyright (c) 2020-present, Elastic NV
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */

import { Journey, JourneyCallback, JourneyOptions } from '../dsl';
import Runner from './runner';
import { VoidCallback, HooksCallback, Location } from '../common_types';
import { wrapFnWithLocation } from '../helpers';
import { log } from './logger';
import { MonitorConfig } from '../dsl/monitor';

/**
 * Use a gloabl Runner which would be accessed by the runtime and
 * required to handle the local vs global invocation through CLI
 */
const SYNTHETICS_RUNNER = Symbol.for('SYNTHETICS_RUNNER');
if (!global[SYNTHETICS_RUNNER]) {
  global[SYNTHETICS_RUNNER] = new Runner();
}

export const runner: Runner = global[SYNTHETICS_RUNNER];

export const journey = wrapFnWithLocation(
  (
    location: Location,
    options: JourneyOptions | string,
    callback: JourneyCallback
  ) => {
    log(`Journey register: ${JSON.stringify(options)}`);
    if (typeof options === 'string') {
      options = { name: options, id: options };
    }
    const j = new Journey(options, callback, location);
    runner.addJourney(j);
    return j;
  }
);

export const step = wrapFnWithLocation(
  (location: Location, name: string, callback: VoidCallback) => {
    log(`Step register: ${name}`);
    return runner.currentJourney?.addStep(name, callback, location);
  }
);

export const monitor = {
  use: wrapFnWithLocation((location: Location, config: MonitorConfig) => {
    /**
     * If the context is inside journey, then set it to journey context
     * otherwise set to the global monitor which will be used for all journeys
     */
    if (runner.currentJourney) {
      runner.currentJourney.updateMonitor(config);
    } else {
      runner.updateMonitor(config);
    }
  }),
};

export const beforeAll = (callback: HooksCallback) => {
  runner.addHook('beforeAll', callback);
};

export const afterAll = (callback: HooksCallback) => {
  runner.addHook('afterAll', callback);
};

export const before = (callback: HooksCallback) => {
  if (!runner.currentJourney) {
    throw new Error('before is called outside of the journey context');
  }
  return runner.currentJourney.addHook('before', callback);
};

export const after = (callback: HooksCallback) => {
  if (!runner.currentJourney) {
    throw new Error('after is called outside of the journey context');
  }
  return runner.currentJourney.addHook('after', callback);
};
