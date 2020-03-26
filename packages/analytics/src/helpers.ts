/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  DynamicConfig,
  DataLayer,
  Gtag,
  CustomParams,
  ControlParams,
  EventParams
} from '@firebase/analytics-types';
import { GtagCommand, GA_FID_KEY, ORIGIN_KEY, GTAG_URL } from './constants';
import { FirebaseInstallations } from '@firebase/installations-types';
import { logger } from './logger';

/**
 * Initialize the analytics instance in gtag.js by calling config command with fid.
 *
 * NOTE: We combine analytics initialization and setting fid together because we want fid to be
 * part of the `page_view` event that's sent during the initialization
 * @param app Firebase app
 * @param gtagCore The gtag function that's not wrapped.
 */
export async function initializeGAId(
  dynamicConfigPromise: Promise<DynamicConfig>,
  installations: FirebaseInstallations,
  gtagCore: Gtag
): Promise<void> {
  const [dynamicConfig, fid] = await Promise.all([
    dynamicConfigPromise,
    installations.getId()
  ]);

  // This command initializes gtag.js and only needs to be called once for the entire web app,
  // but since it is idempotent, we can call it multiple times.
  // We keep it together with other initialization logic for better code structure.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gtagCore('js' as any, new Date());

  // It should be the first config command called on this GA-ID
  // Initialize this GA-ID and set FID on it using the gtag config API.
  gtagCore(GtagCommand.CONFIG, dynamicConfig.measurementId, {
    [GA_FID_KEY]: fid,
    // guard against developers accidentally setting properties with prefix `firebase_`
    [ORIGIN_KEY]: 'firebase',
    update: true
  });
}

export function insertScriptTag(dataLayerName: string): void {
  const script = document.createElement('script');
  // We are not providing an analyticsId in the URL because it would trigger a `page_view`
  // without fid. We will initialize ga-id using gtag (config) command together with fid.
  script.src = `${GTAG_URL}?l=${dataLayerName}`;
  script.async = true;
  document.head.appendChild(script);
}

/** Get reference to, or create, global datalayer.
 * @param dataLayerName Name of datalayer (most often the default, "_dataLayer")
 */
export function getOrCreateDataLayer(dataLayerName: string): DataLayer {
  // Check for existing dataLayer and create if needed.
  let dataLayer: DataLayer = [];
  if (Array.isArray(window[dataLayerName])) {
    dataLayer = window[dataLayerName] as DataLayer;
  } else {
    window[dataLayerName] = dataLayer;
  }
  return dataLayer;
}
/**
 * Wraps a standard gtag function with extra code to wait for completion of
 * relevant initialization promises before sending requests.
 *
 * @param gtagCore Basic gtag function that just appends to dataLayer
 * @param initializedIdPromisesMap Map of gaIds to their initialization promises
 */
function wrapGtag(
  gtagCore: Gtag,
  initializationPromisesMap: { [appId: string]: Promise<void> },
  dynamicConfigPromisesList: Array<Promise<DynamicConfig>>,
  measurementIdToAppId: { [measurementId: string]: string }
): Function {
  /**
   * Wrapped gtag logic when gtag is called with 'config' command.
   *
   * @param measurementId GA Measurement ID.
   * @param gtagParams Config params.
   */
  function gtagOnConfig(
    measurementId: string,
    gtagParams?: ControlParams & EventParams & CustomParams
  ): void {
    let initializationPromiseToWaitFor: Promise<void>;
    // If config is fetched, we know the appId and can use it to look up what FID promise we
    /// are waiting for, and wait only on that one.
    const correspondingAppId = measurementIdToAppId[measurementId as string];
    if (correspondingAppId) {
      initializationPromiseToWaitFor =
        initializationPromisesMap[correspondingAppId];
    } else {
      // If config is not fetched, wait for all configs (we don't know which one we need) and
      // find the appId (if any) corresponding to this measurementId. If there is one, wait on
      // that appId's initialization promise. If there is none, promise resolves and gtag
      // call goes through.
      initializationPromiseToWaitFor = Promise.all(dynamicConfigPromisesList)
        .then(dynamicConfigResults => {
          const foundConfig = dynamicConfigResults.find(
            config => config.measurementId === measurementId
          );
          if (foundConfig) {
            return initializationPromisesMap[foundConfig.appId];
          }
        })
        .catch(e => logger.error(e));
    }
    initializationPromiseToWaitFor
      .then(() => {
        gtagCore(GtagCommand.CONFIG, measurementId, gtagParams);
      })
      .catch(e => logger.error(e));
  }

  /**
   * Wrapped gtag logic when gtag is called with 'event' command.
   *
   * @param measurementId GA Measurement ID.
   * @param gtagParams Event params.
   */
  function gtagOnEvent(
    measurementId: string,
    gtagParams?: ControlParams & EventParams & CustomParams
  ): void {
    let initializationPromisesToWaitFor: Array<Promise<void>> = [];
    // If there's a 'send_to' param, check if any ID specified matches
    // a FID we have begun a fetch on.
    if (gtagParams && gtagParams['send_to']) {
      let gaSendToList: string | string[] = gtagParams['send_to'];
      // Make it an array if is isn't, so it can be dealt with the same way.
      if (!Array.isArray(gaSendToList)) {
        gaSendToList = [gaSendToList];
      }
      // Checking 'send_to' fields requires having all measurement ID results back from
      // the dynamic config fetch.
      Promise.all(dynamicConfigPromisesList)
        .then(dynamicConfigResults => {
          for (const sendToId of gaSendToList) {
            const foundConfig = dynamicConfigResults.find(
              config => config.measurementId === sendToId
            );
            const initializationPromise =
              foundConfig && initializationPromisesMap[foundConfig.appId];
            // Groups will not be in the map.
            if (initializationPromise) {
              initializationPromisesToWaitFor.push(initializationPromise);
            } else {
              // There is an item in 'send_to' that is not associated
              // directly with an FID, possibly a group.  Empty this array
              // and let it get populated below.
              initializationPromisesToWaitFor = [];
              break;
            }
          }
        })
        .catch(e => logger.error(e));
    }

    // This will be unpopulated if there was no 'send_to' field , or
    // if not all entries in the 'send_to' field could be mapped to
    // a FID. In these cases, wait on all pending initialization promises.
    if (initializationPromisesToWaitFor.length === 0) {
      initializationPromisesToWaitFor = Object.values(
        initializationPromisesMap
      );
    }
    // Run core gtag function with args after all relevant initialization
    // promises have been resolved.
    Promise.all(initializationPromisesToWaitFor)
      // Workaround for http://b/141370449 - third argument cannot be undefined.
      .then(() => gtagCore(GtagCommand.EVENT, measurementId, gtagParams || {}))
      .catch(e => logger.error(e));
  }

  /**
   * Wrapper around gtag that ensures FID is sent with gtag calls.
   * @param command Gtag command type.
   * @param idOrNameOrParams Measurement ID if command is EVENT/CONFIG, params if command is SET.
   * @param gtagParams Params if event is EVENT/CONFIG.
   */
  function gtagWrapper(
    command: 'config' | 'set' | 'event',
    idOrNameOrParams: string | ControlParams,
    gtagParams?: ControlParams & EventParams & CustomParams
  ): void {
    // If event, check that relevant initialization promises have completed.
    if (command === GtagCommand.EVENT) {
      // If EVENT, second arg must be measurementId.
      gtagOnEvent(idOrNameOrParams as string, gtagParams);
    } else if (command === GtagCommand.CONFIG) {
      // If CONFIG, second arg must be measurementId.
      gtagOnConfig(idOrNameOrParams as string, gtagParams);
    } else {
      // If SET, second arg must be params.
      gtagCore(GtagCommand.SET, idOrNameOrParams as CustomParams);
    }
  }

  return gtagWrapper;
}

/**
 * Creates global gtag function or wraps existing one if found.
 * This wrapped function attaches Firebase instance ID (FID) to gtag 'config' and
 * 'event' calls that belong to the GAID associated with this Firebase instance.
 *
 * @param initializedIdPromisesMap Map of gaId to initialization promises.
 * @param dataLayerName Name of global GA datalayer array.
 * @param gtagFunctionName Name of global gtag function ("gtag" if not user-specified)
 */
export function wrapOrCreateGtag(
  initializationPromisesMap: { [appId: string]: Promise<void> },
  dynamicConfigPromisesList: Array<Promise<DynamicConfig>>,
  measurementIdToAppId: { [measurementId: string]: string },
  dataLayerName: string,
  gtagFunctionName: string
): {
  gtagCore: Gtag;
  wrappedGtag: Gtag;
} {
  // Create a basic core gtag function
  let gtagCore: Gtag = function(..._args: unknown[]) {
    // Must push IArguments object, not an array.
    (window[dataLayerName] as DataLayer).push(arguments);
  };

  // Replace it with existing one if found
  if (
    window[gtagFunctionName] &&
    typeof window[gtagFunctionName] === 'function'
  ) {
    // @ts-ignore
    gtagCore = window[gtagFunctionName];
  }

  window[gtagFunctionName] = wrapGtag(
    gtagCore,
    initializationPromisesMap,
    dynamicConfigPromisesList,
    measurementIdToAppId
  );

  return {
    gtagCore,
    wrappedGtag: window[gtagFunctionName] as Gtag
  };
}

/**
 * Returns first script tag in DOM matching our gtag url pattern.
 */
export function findGtagScriptOnPage(): HTMLScriptElement | null {
  const scriptTags = window.document.getElementsByTagName('script');
  for (const tag of Object.values(scriptTags)) {
    if (tag.src && tag.src.includes(GTAG_URL)) {
      return tag;
    }
  }
  return null;
}
