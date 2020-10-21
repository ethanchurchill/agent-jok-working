let logLevel = 1;

/**
 * Set the log level.
 *
 * @param {number} level
 */
module.exports.setLogLevel = (level) => {
  logLevel = level;
}

/**
 * Log an expression to console at a specific level.
 *
 * @param {any} msg
 * @param {number} [level]
 */
module.exports.logExpression = (msg, level) => {
  if (level !== undefined && level > logLevel) {
    return;
  }
  const now = new Date();
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((val) => val.toString().padStart(2, '0')).join('-');
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((val) => val.toString().padStart(2, '0')).join(':');
  const datetime = `[${date} ${time}.${now.getMilliseconds().toString().padStart(3, '0').substr(0, 2)}]`;
  if (typeof msg === 'object') {
    console.log(datetime);
    console.log(JSON.stringify(msg, null, 2));
  }
  else {
    console.log(`${datetime} ${msg}`);
  }
}
