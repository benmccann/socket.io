import { Polling } from "./polling.js";
import { Emitter } from "@socket.io/component-emitter";
import type { SocketOptions } from "../socket.js";
import { installTimerFunctions, pick } from "../util.js";
import {
  globalThisShim as globalThis,
  createCookieJar,
} from "../globals.node.js";
import type { CookieJar } from "../globals.node.js";
import type { RawData } from "engine.io-parser";
import { hasCORS } from "../contrib/has-cors.js";
import debugModule from "debug"; // debug()

const debug = debugModule("engine.io-client:polling"); // debug()

function empty() {}

export abstract class BaseXHR extends Polling {
  protected readonly xd: boolean;
  protected readonly cookieJar?: CookieJar;

  private pollXhr: any;

  /**
   * XHR Polling constructor.
   *
   * @param {Object} opts
   * @package
   */
  constructor(opts) {
    super(opts);

    if (typeof location !== "undefined") {
      const isSSL = "https:" === location.protocol;
      let port = location.port;

      // some user agents have empty `location.port`
      if (!port) {
        port = isSSL ? "443" : "80";
      }

      this.xd =
        (typeof location !== "undefined" &&
          opts.hostname !== location.hostname) ||
        port !== opts.port;
    }

    if (this.opts.withCredentials) {
      this.cookieJar = createCookieJar();
    }
  }

  /**
   * Creates a request.
   *
   * @private
   */
  abstract request(opts?: Record<string, any>);

  /**
   * Sends data.
   *
   * @param {String} data to send.
   * @param {Function} called upon flush.
   * @private
   */
  override doWrite(data, fn) {
    const req = this.request({
      method: "POST",
      data: data,
    });
    req.on("success", fn);
    req.on("error", (xhrStatus, context) => {
      this.onError("xhr post error", xhrStatus, context);
    });
  }

  /**
   * Starts a poll cycle.
   *
   * @private
   */
  override doPoll() {
    debug("xhr poll");
    const req = this.request();
    req.on("data", this.onData.bind(this));
    req.on("error", (xhrStatus, context) => {
      this.onError("xhr poll error", xhrStatus, context);
    });
    this.pollXhr = req;
  }
}

interface RequestReservedEvents {
  success: () => void;
  data: (data: RawData) => void;
  error: (err: number | Error, context: unknown) => void; // context should be typed as XMLHttpRequest, but this type is not available on non-browser platforms
}

export type RequestOptions = SocketOptions & {
  method?: string;
  data?: RawData;
  xd: boolean;
  cookieJar: CookieJar;
};

export class Request extends Emitter<
  Record<never, never>,
  Record<never, never>,
  RequestReservedEvents
> {
  private readonly opts: RequestOptions;
  private readonly method: string;
  private readonly uri: string;
  private readonly data: string | ArrayBuffer;

  private xhr: any;
  private setTimeoutFn: typeof setTimeout;
  private index: number;

  static requestsCount = 0;
  static requests = {};

  /**
   * Request constructor
   *
   * @param {Object} options
   * @package
   */
  constructor(
    private readonly createRequest: (opts: RequestOptions) => XMLHttpRequest,
    uri: string,
    opts: RequestOptions
  ) {
    super();
    installTimerFunctions(this, opts);
    this.opts = opts;

    this.method = opts.method || "GET";
    this.uri = uri;
    this.data = undefined !== opts.data ? opts.data : null;

    this.create();
  }

  /**
   * Creates the XHR object and sends the request.
   *
   * @private
   */
  private create() {
    const opts = pick(
      this.opts,
      "agent",
      "pfx",
      "key",
      "passphrase",
      "cert",
      "ca",
      "ciphers",
      "rejectUnauthorized",
      "autoUnref"
    );
    opts.xdomain = !!this.opts.xd;

    const xhr = (this.xhr = this.createRequest(opts));

    try {
      debug("xhr open %s: %s", this.method, this.uri);
      xhr.open(this.method, this.uri, true);
      try {
        if (this.opts.extraHeaders) {
          // @ts-ignore
          xhr.setDisableHeaderCheck && xhr.setDisableHeaderCheck(true);
          for (let i in this.opts.extraHeaders) {
            if (this.opts.extraHeaders.hasOwnProperty(i)) {
              xhr.setRequestHeader(i, this.opts.extraHeaders[i]);
            }
          }
        }
      } catch (e) {}

      if ("POST" === this.method) {
        try {
          xhr.setRequestHeader("Content-type", "text/plain;charset=UTF-8");
        } catch (e) {}
      }

      try {
        xhr.setRequestHeader("Accept", "*/*");
      } catch (e) {}

      this.opts.cookieJar?.addCookies(xhr);

      // ie6 check
      if ("withCredentials" in xhr) {
        xhr.withCredentials = this.opts.withCredentials;
      }

      if (this.opts.requestTimeout) {
        xhr.timeout = this.opts.requestTimeout;
      }

      xhr.onreadystatechange = () => {
        if (xhr.readyState === 3) {
          this.opts.cookieJar?.parseCookies(
            // @ts-ignore
            xhr.getResponseHeader("set-cookie")
          );
        }

        if (4 !== xhr.readyState) return;
        if (200 === xhr.status || 1223 === xhr.status) {
          this.onLoad();
        } else {
          // make sure the `error` event handler that's user-set
          // does not throw in the same tick and gets caught here
          this.setTimeoutFn(() => {
            this.onError(typeof xhr.status === "number" ? xhr.status : 0);
          }, 0);
        }
      };

      debug("xhr data %s", this.data);
      xhr.send(this.data);
    } catch (e) {
      // Need to defer since .create() is called directly from the constructor
      // and thus the 'error' event can only be only bound *after* this exception
      // occurs.  Therefore, also, we cannot throw here at all.
      this.setTimeoutFn(() => {
        this.onError(e);
      }, 0);
      return;
    }

    if (typeof document !== "undefined") {
      this.index = Request.requestsCount++;
      Request.requests[this.index] = this;
    }
  }

  /**
   * Called upon error.
   *
   * @private
   */
  private onError(err: number | Error) {
    this.emitReserved("error", err, this.xhr);
    this.cleanup(true);
  }

  /**
   * Cleans up house.
   *
   * @private
   */
  private cleanup(fromError?) {
    if ("undefined" === typeof this.xhr || null === this.xhr) {
      return;
    }
    this.xhr.onreadystatechange = empty;

    if (fromError) {
      try {
        this.xhr.abort();
      } catch (e) {}
    }

    if (typeof document !== "undefined") {
      delete Request.requests[this.index];
    }

    this.xhr = null;
  }

  /**
   * Called upon load.
   *
   * @private
   */
  private onLoad() {
    const data = this.xhr.responseText;
    if (data !== null) {
      this.emitReserved("data", data);
      this.emitReserved("success");
      this.cleanup();
    }
  }

  /**
   * Aborts the request.
   *
   * @package
   */
  public abort() {
    this.cleanup();
  }
}

/**
 * Aborts pending requests when unloading the window. This is needed to prevent
 * memory leaks (e.g. when using IE) and to ensure that no spurious error is
 * emitted.
 */

if (typeof document !== "undefined") {
  // @ts-ignore
  if (typeof attachEvent === "function") {
    // @ts-ignore
    attachEvent("onunload", unloadHandler);
  } else if (typeof addEventListener === "function") {
    const terminationEvent = "onpagehide" in globalThis ? "pagehide" : "unload";
    addEventListener(terminationEvent, unloadHandler, false);
  }
}

function unloadHandler() {
  for (let i in Request.requests) {
    if (Request.requests.hasOwnProperty(i)) {
      Request.requests[i].abort();
    }
  }
}

const hasXHR2 = (function () {
  const xhr = newRequest({
    xdomain: false,
  });
  return xhr && xhr.responseType !== null;
})();

/**
 * HTTP long-polling based on the built-in `XMLHttpRequest` object.
 *
 * Usage: browser
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest
 */
export class XHR extends BaseXHR {
  constructor(opts) {
    super(opts);
    const forceBase64 = opts && opts.forceBase64;
    this.supportsBinary = hasXHR2 && !forceBase64;
  }

  request(opts: Record<string, any> = {}) {
    Object.assign(opts, { xd: this.xd, cookieJar: this.cookieJar }, this.opts);
    return new Request(newRequest, this.uri(), opts as RequestOptions);
  }
}

function newRequest(opts) {
  const xdomain = opts.xdomain;

  // XMLHttpRequest can be disabled on IE
  try {
    if ("undefined" !== typeof XMLHttpRequest && (!xdomain || hasCORS)) {
      return new XMLHttpRequest();
    }
  } catch (e) {}

  if (!xdomain) {
    try {
      return new globalThis[["Active"].concat("Object").join("X")](
        "Microsoft.XMLHTTP"
      );
    } catch (e) {}
  }
}
