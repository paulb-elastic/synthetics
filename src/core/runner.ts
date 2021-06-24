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

import { once, EventEmitter } from 'events';
import { join } from 'path';
import { mkdirSync, rmdirSync, writeFileSync } from 'fs';
import { Journey } from '../dsl/journey';
import { Step } from '../dsl/step';
import { reporters, Reporter } from '../reporters';
import {
  CACHE_PATH,
  monotonicTimeInSeconds,
  getTimestamp,
  now,
  runParallel,
} from '../helpers';
import {
  StatusValue,
  HooksCallback,
  Params,
  PluginOutput,
  CliArgs,
  HooksArgs,
} from '../common_types';
import { PluginManager } from '../plugins';
import { PerformanceManager, Metrics } from '../plugins';
import { Driver, Gatherer } from './gatherer';
import { log } from './logger';

export type RunOptions = Omit<
  CliArgs,
  | 'debug'
  | 'json'
  | 'pattern'
  | 'inline'
  | 'require'
  | 'suiteParams'
  | 'reporter'
  | 'richEvents'
  | 'capability'
> & {
  environment?: string;
  params?: Params;
  reporter?: CliArgs['reporter'] | Reporter;
};

type BaseContext = {
  params?: Params;
  start: number;
  end?: number;
};

type JourneyContext = BaseContext & {
  driver: Driver;
  pluginManager: PluginManager;
};

type StepResult = {
  status: StatusValue;
  url?: string;
  metrics?: Metrics;
  error?: Error;
};

type JourneyResult = {
  status: StatusValue;
  error?: Error;
};

type RunResult = Record<string, JourneyResult>;

type HookType = 'beforeAll' | 'afterAll';
export type SuiteHooks = Record<HookType, Array<HooksCallback>>;

interface Events {
  start: { numJourneys: number };
  'journey:register': {
    journey: Journey;
  };
  'journey:start': {
    journey: Journey;
    timestamp: number;
    params: Params;
  };
  'journey:end': BaseContext &
    JourneyResult &
    PluginOutput & {
      journey: Journey;
      options: RunOptions;
    };
  'journey:end:reported': unknown;
  'step:start': { journey: Journey; step: Step };
  'step:end': StepResult & {
    start: number;
    end: number;
    journey: Journey;
    step: Step;
  };
  end: unknown;
}

export default interface Runner {
  on<K extends keyof Events>(name: K, listener: (v: Events[K]) => void): this;
  emit<K extends keyof Events>(event: K, args: Events[K]): boolean;
}

export default class Runner extends EventEmitter {
  active = false;
  currentJourney?: Journey = null;
  journeys: Journey[] = [];
  hooks: SuiteHooks = { beforeAll: [], afterAll: [] };
  screenshotPath = join(CACHE_PATH, 'screenshots');
  hookError: Error | undefined;

  static async createContext(options: RunOptions): Promise<JourneyContext> {
    const start = monotonicTimeInSeconds();
    const driver = await Gatherer.setupDriver(options);
    const pluginManager = await Gatherer.beginRecording(driver, options);
    return {
      start,
      params: options.params,
      driver,
      pluginManager,
    };
  }

  async captureScreenshot(page: Driver['page'], step: Step) {
    await page.waitForLoadState('load');
    const buffer = await page
      .screenshot({
        type: 'jpeg',
        quality: 80,
      })
      .catch(() => {});
    /**
     * Write the screenshot image buffer with additional details (step
     * information) which could be extracted at the end of
     * each journey without impacting the step timing information
     */
    if (buffer) {
      const fileName = now().toString() + '.json';
      writeFileSync(
        join(this.screenshotPath, fileName),
        JSON.stringify({
          step,
          data: buffer.toString('base64'),
        })
      );
    }
  }

  addHook(type: HookType, callback: HooksCallback) {
    this.hooks[type].push(callback);
  }

  addJourney(journey: Journey) {
    this.journeys.push(journey);
    this.currentJourney = journey;
  }

  async runBeforeAllHook(args: HooksArgs) {
    log(`Runner: beforeAll hooks`);
    await runParallel(this.hooks.beforeAll, args);
  }

  async runAfterAllHook(args: HooksArgs) {
    log(`Runner: afterAll hooks`);
    await runParallel(this.hooks.afterAll, args);
  }

  async runBeforeHook(journey: Journey, args: HooksArgs) {
    log(`Runner: before hooks for (${journey.name})`);
    await runParallel(journey.hooks.before, args);
  }

  async runAfterHook(journey: Journey, args: HooksArgs) {
    log(`Runner: after hooks for (${journey.name})`);
    await runParallel(journey.hooks.after, args);
  }

  async runStep(
    step: Step,
    context: JourneyContext,
    options: RunOptions
  ): Promise<StepResult> {
    const data: StepResult = {
      status: 'succeeded',
    };
    log(`Runner: start step (${step.name})`);
    const { metrics, screenshots } = options;
    const { driver, pluginManager } = context;
    /**
     * URL needs to be the first navigation request of any step
     * Listening for request solves the case where `about:blank` would be
     * reported for failed navigations
     */
    const captureUrl = req => {
      if (!data.url && req.isNavigationRequest()) {
        data.url = req.url();
      }
      driver.page.off('request', captureUrl);
    };
    driver.page.on('request', captureUrl);
    try {
      pluginManager.onStep(step);
      await step.callback();
      if (metrics) {
        data.metrics = await pluginManager.get(PerformanceManager).getMetrics();
      }
    } catch (error) {
      data.status = 'failed';
      data.error = error;
    } finally {
      data.url ??= driver.page.url();
      if (screenshots && screenshots !== 'off') {
        await this.captureScreenshot(driver.page, step);
      }
    }
    log(`Runner: end step (${step.name})`);
    return data;
  }

  async runSteps(
    journey: Journey,
    context: JourneyContext,
    options: RunOptions
  ) {
    const results: Array<StepResult> = [];
    let skipStep = false;
    for (const step of journey.steps) {
      const start = monotonicTimeInSeconds();
      this.emit('step:start', { journey, step });
      let data: StepResult = { status: 'succeeded' };
      if (skipStep) {
        data.status = 'skipped';
      } else {
        data = await this.runStep(step, context, options);
        /**
         * skip next steps if the previous step returns error
         */
        if (data.error) skipStep = true;
      }
      this.emit('step:end', {
        journey,
        step,
        start,
        end: monotonicTimeInSeconds(),
        ...data,
      });
      if (options.pauseOnError && data.error) {
        await new Promise(r => process.stdin.on('data', r));
      }
      results.push(data);
    }
    return results;
  }

  registerJourney(journey: Journey, context: JourneyContext) {
    this.currentJourney = journey;
    const timestamp = getTimestamp();
    const { params } = context;
    this.emit('journey:start', { journey, timestamp, params });
    /**
     * Load and register the steps for the current journey
     */
    journey.callback({ ...context.driver, params });
  }

  async endJourney(
    journey,
    result: JourneyContext & JourneyResult,
    options: RunOptions
  ) {
    const { pluginManager, start, status, error } = result;
    const pluginOutput = await pluginManager.output();
    this.emit('journey:end', {
      journey,
      status,
      error,
      start,
      end: monotonicTimeInSeconds(),
      options,
      ...pluginOutput,
      browserconsole: status == 'failed' ? pluginOutput.browserconsole : [],
    });
    /**
     * Wait for the all the reported events to be consumed aschronously
     * by reporter.
     */
    if (options.reporter === 'json') {
      await once(this, 'journey:end:reported');
    }
  }

  /**
   * Simulate a journey run to capture errors in the beforeAll hook
   */
  async runFakeJourney(journey: Journey, options: RunOptions) {
    const start = monotonicTimeInSeconds();
    this.emit('journey:start', {
      journey,
      timestamp: getTimestamp(),
      params: options.params,
    });
    const result: JourneyResult = {
      status: 'failed',
      error: this.hookError,
    };
    this.emit('journey:end', {
      journey,
      start,
      options,
      end: monotonicTimeInSeconds(),
      ...result,
    });
    if (options.reporter === 'json') {
      await once(this, 'journey:end:reported');
    }
    return result;
  }

  async runJourney(journey: Journey, options: RunOptions) {
    const result: JourneyResult = {
      status: 'succeeded',
    };
    log(`Runner: start journey (${journey.name})`);
    const context = await Runner.createContext(options);
    try {
      this.registerJourney(journey, context);
      const hookArgs = {
        env: options.environment,
        params: options.params,
      };
      await this.runBeforeHook(journey, hookArgs);
      const stepResults = await this.runSteps(journey, context, options);
      /**
       * Mark journey as failed if any intermediate step fails
       */
      for (const stepResult of stepResults) {
        if (stepResult.status === 'failed') {
          result.status = stepResult.status;
          result.error = stepResult.error;
        }
      }
      await this.runAfterHook(journey, hookArgs);
    } catch (e) {
      result.status = 'failed';
      result.error = e;
    } finally {
      await this.endJourney(journey, { ...context, ...result }, options);
      await Gatherer.dispose(context.driver);
    }
    log(`Runner: end journey (${journey.name})`);
    return result;
  }

  init(options: RunOptions) {
    const { reporter, outfd } = options;
    /**
     * Set up the corresponding reporter and fallback
     */
    const Reporter =
      typeof reporter === 'function'
        ? reporter
        : reporters[reporter] || reporters['default'];
    new Reporter(this, { fd: outfd });
    this.emit('start', { numJourneys: this.journeys.length });
    /**
     * Set up the directory for caching screenshots
     */
    mkdirSync(this.screenshotPath, { recursive: true });
  }

  async run(options: RunOptions) {
    const result: RunResult = {};
    if (this.active) {
      return result;
    }
    this.active = true;
    log(`Runner: run ${this.journeys.length} journeys`);
    this.init(options);
    await this.runBeforeAllHook({
      env: options.environment,
      params: options.params,
    }).catch(e => (this.hookError = e));

    const { dryRun, match, tags } = options;
    for (const journey of this.journeys) {
      /**
       * Used by heartbeat to gather all registered journeys
       */
      if (dryRun) {
        this.emit('journey:register', { journey });
        continue;
      }
      if (!journey.isMatch(match, tags)) {
        continue;
      }
      const journeyResult: JourneyResult = this.hookError
        ? await this.runFakeJourney(journey, options)
        : await this.runJourney(journey, options);
      result[journey.name] = journeyResult;
    }
    await Gatherer.stop();
    await this.runAfterAllHook({
      env: options.environment,
      params: options.params,
    });
    this.reset();
    return result;
  }

  reset() {
    /**
     * Clear all cache data stored for post processing by
     * the current synthetic agent run
     */
    rmdirSync(CACHE_PATH, { recursive: true });
    this.currentJourney = null;
    this.journeys = [];
    this.active = false;
    this.emit('end', {});
  }
}
