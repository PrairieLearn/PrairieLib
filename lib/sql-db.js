const ERR = require('async-stacktrace');
const _ = require('lodash');
const pg = require('pg');
const path = require('path');
const debug = require('debug')('prairielib:' + path.basename(__filename, '.js'));
const { promisify } = require('util');

const error = require('./error');

function debugString(s) {
    if (!_.isString(s)) return 'NOT A STRING';
    s = s.replace(/\n/g, '\\n');
    if (s.length > 78) s = s.substring(0, 75) + '...';
    s = '"' + s + '"';
    return s;
};

function debugParams(params) {
    let s;
    try {
        s = JSON.stringify(params);
    } catch (err) {
        s = 'CANNOT JSON STRINGIFY';
    }
    return debugString(s);
};

/**
 * 
 * @param {String} sql 
 * @param {Object | Array} params 
 * @param {*} callback 
 */
function paramsToArray(sql, params, callback) {
    if (!_.isString(sql)) return callback(new Error('SQL must be a string'));
    if (_.isArray(params)) return callback(null, sql, params);
    if (!_.isObjectLike(params)) return callback(new Error('params must be array or object'));
    const re = /\$([-_a-zA-Z0-9]+)/;
    let result;
    let processedSql = '';
    let remainingSql = sql;
    let nParams = 0;
    const map = {};
    let paramsArray = [];
    while ((result = re.exec(remainingSql)) !== null) {
        const v = result[1];
        if (!_(map).has(v)) {
            if (!_(params).has(v)) return callback(new Error('Missing parameter: ' + v));
            if (_.isArray(params[v])) {
                map[v] = 'ARRAY[' + _.map(_.range(nParams + 1, nParams + params[v].length + 1), function(n) {return '$' + n;}).join(',') + ']';
                nParams += params[v].length;
                paramsArray = paramsArray.concat(params[v]);
            } else {
                nParams++;
                map[v] = '$' + nParams;
                paramsArray.push(params[v]);
            }
        }
        processedSql += remainingSql.substring(0, result.index) + map[v];
        remainingSql = remainingSql.substring(result.index + result[0].length);
    }
    processedSql += remainingSql;
    remainingSql = '';
    callback(null, processedSql, paramsArray);
}

/** @type { import("pg").Pool } */
let pool = null;

/** @typedef {Object | Array} Params */
/** @typedef {(error: Error | null, result: import("pg").QueryResult) => void} ResultsCallback */

/**
 * @param { import("pg").PoolConfig } pgConfig - The config object for Postgres
 * @param {(error: Error, client: import("pg").PoolClient) => void} idleErrorHandler - A handler for async errors
 * @param {(error: Error | null) => void} callback - Callback once the connection is initialized
 */
module.exports.init = function(pgConfig, idleErrorHandler, callback) {
    try {
        pool = new pg.Pool(pgConfig);
    } catch (err) {
        error.addData(err, {pgConfig: pgConfig});
        callback(err);
        return;
    }
    pool.on('error', function(err, client) {
        idleErrorHandler(err, client);
    });

    let retryCount = 0;
    const retryTimeouts = [500, 1000, 2000, 5000, 10000];
    const tryConnect = () => {
        pool.connect((err, client, done) => {
            if (err) {
                if (client) {
                    done(client);
                }

                if (retryCount >= retryTimeouts.length) {
                    err.message = `Couldn't connect to Postgres after ${retryTimeouts.length} retries: ${err.message}`;
                    callback(err);
                    return;
                }

                const timeout = retryTimeouts[retryCount];
                retryCount++;
                setTimeout(tryConnect, timeout);
            } else {
                done();
                callback(null);
            }
        });
    };
    tryConnect();
}

/**
 * @param {(error: Error | null) => void} callback
 */
module.exports.close = function(callback) {
    if (!pool) {
        return callback(null);
    }
    pool.end((err) => {
        if (ERR(err, callback)) return;
        pool = null;
        callback(null);
    });
}

/**
 * @param {(error: Error | null, client: import("pg").PoolClient, done: (release?: any) => void) => void} callback
 */
module.exports.getClient = function(callback) {
    if (!pool) {
        return callback(new Error('Connection pool is not open'));
    }
    pool.connect(function(err, client, done) {
        if (err) {
            if (client) {
                done(client);
            }
            return ERR(err, callback); // unconditionally return
        }
        callback(null, client, done);
    });
}

/**
 * @returns {Promise<{client: import("pg").PoolClient, done: (release?: any) => void}>}
 */
module.exports.getClientAsync = function(callback) {
    return new Promise((resolve, reject) => {
        module.exports.getClient((err, client, done) => {
            if (err) {
                reject(err);
            } else {
                resolve({ client, done });
            }
        });
    });
}

/**
 * @param { import("pg").PoolClient } client - The client with which to execute the query
 * @param {String} sql - The SQL query to execute
 * @param {Params} params
 */
module.exports.queryWithClient = function(client, sql, params, callback) {
    debug('queryWithClient()', 'sql:', debugString(sql));
    debug('queryWithClient()', 'params:', debugParams(params));
    paramsToArray(sql, params, function(err, newSql, newParams) {
        if (err) err = error.addData(err, {sql: sql, sqlParams: params});
        if (ERR(err, callback)) return;
        client.query(newSql, newParams, function(err, result) {
            if (err) {
                const sqlError = JSON.parse(JSON.stringify(err));
                sqlError.message = err.message;
                err = error.addData(err, {sqlError: sqlError, sql: sql, sqlParams: params, result: result});
            }
            if (ERR(err, callback)) return;
            debug('queryWithClient() success', 'rowCount:', result.rowCount);
            callback(null, result);
        });
    });
}

module.exports.queryWithClientAsync = promisify(module.exports.queryWithClient);

/**
 * @param { import("pg").PoolClient } client - The client with which to execute the query
 * @param {String} sql - The SQL query to execute
 * @param {Params} params
 */
module.exports.queryWithClientOneRow = function(client, sql, params, callback) {
    debug('queryWithClientOneRow()', 'sql:', debugString(sql));
    debug('queryWithClientOneRow()', 'params:', debugParams(params));
    module.exports.queryWithClient(client, sql, params, function(err, result) {
        if (ERR(err, callback)) return;
        if (result.rowCount !== 1) {
            const data = {sql: sql, sqlParams: params, result: result};
            return callback(error.makeWithData('Incorrect rowCount: ' + result.rowCount, data));
        }
        debug('queryWithClientOneRow() success', 'rowCount:', result.rowCount);
        callback(null, result);
    });
};

module.exports.queryWithClientOneRowAsync = promisify(module.exports.queryWithClientOneRow);

/**
 * @param { import("pg").PoolClient } client - The client with which to execute the query
 * @param {String} sql - The SQL query to execute
 * @param {Params} params
 */
module.exports.queryWithClientZeroOrOneRow = function(client, sql, params, callback) {
    debug('queryWithClientZeroOrOneRow()', 'sql:', debugString(sql));
    debug('queryWithClientZeroOrOneRow()', 'params:', debugParams(params));
    module.exports.queryWithClient(client, sql, params, function(err, result) {
        if (ERR(err, callback)) return;
        if (result.rowCount > 1) {
            const data = {sql: sql, sqlParams: params, result: result};
            return callback(error.makeWithData('Incorrect rowCount: ' + result.rowCount, data));
        }
        debug('queryWithClientZeroOrOneRow() success', 'rowCount:', result.rowCount);
        callback(null, result);
    });
}

module.exports.queryWithClientZeroOrOneRowAsync = promisify(module.exports.queryWithClientZeroOrOneRow);

/**
 * @param {import("pg").PoolClient} client
 * @param {(release?: any) => void} done
 * @param {(err: Error | null) => void} callback
 */
module.exports.rollbackWithClient = function(client, done, callback) {
    debug('rollbackWithClient()');
    // from https://github.com/brianc/node-postgres/wiki/Transactions
    client.query('ROLLBACK;', function(err) {
        //if there was a problem rolling back the query
        //something is seriously messed up.  Return the error
        //to the done function to close & remove this client from
        //the pool.  If you leave a client in the pool with an unaborted
        //transaction weird, hard to diagnose problems might happen.
        done(err);
        if (ERR(err, callback)) return;
        callback(null);
    });
};

module.exports.rollbackWithClientAsync = promisify(module.exports.rollbackWithClient);

/**
 * @param {(err: Error | null, client?: import("pg").PoolClient, done?: (release?: any) => void) => void} callback
 */
module.exports.beginTransaction = function(callback) {
    debug('beginTransaction()');
    module.exports.getClient(function(err, client, done) {
        if (ERR(err, callback)) return;
        module.exports.queryWithClient(client, 'START TRANSACTION;', [], function(err) {
            if (err) {
                module.exports.rollbackWithClient(client, done, function(rollbackErr) {
                    if (ERR(rollbackErr, callback)) return;
                    return ERR(err, callback);
                });
            } else {
                callback(null, client, done);
            }
        });
    });
}

/**
 * @returns {Promise<{client: import("pg").PoolClient, done: (release?: any) => void}>}
 */
module.exports.begiTransactionAsync = function() {
    return new Promise((resolve, reject) => {
        module.exports.beginTransaction((err, client, done) => {
            if (err) {
                reject(err);
            } else {
                resolve({ client, done });
            }
        });
    });
}

/**
 * Commits the transaction if err is null, otherwize rollbacks the transaction.
 * Also releasese the client.
 * 
 * @param { import("pg").PoolClient } client
 * @param {(rollback?: any) => void} done
 * @param {Error | null} err
 * @param {(error: Error | null) => void} callback
 */
module.exports.endTransaction = function(client, done, err, callback) {
    debug('endTransaction()');
    if (err) {
        module.exports.rollbackWithClient(client, done, function(rollbackErr) {
            if (rollbackErr) {
                rollbackErr = error.addData(rollbackErr, {prevErr: err, rollback: 'fail'});
                return ERR(rollbackErr, callback);
            }
            err = error.addData(err, {rollback: 'success'});
            ERR(err, callback);
        });
    } else {
        module.exports.queryWithClient(client, 'COMMIT', [], function(err, _result) {
            if (err) {
                done();
                return ERR(err, callback); // unconditionally return
            }
            done();
            callback(null);
        });
    }
}

module.exports.endTransactionAsync = promisify(module.exports.endTransaction);

/**
 * @param {string} sql - The SQL query to execute
 * @param {Params} params - The params for the query
 * @param {ResultsCallback} callback
 */
module.exports.query = function(sql, params, callback) {
    debug('query()', 'sql:', debugString(sql));
    debug('query()', 'params:', debugParams(params));
    if (!pool) {
        return callback(new Error('Connection pool is not open'));
    }
    pool.connect(function(err, client, done) {
        const handleError = function(err) {
            if (!err) return false;
            if (client) {
                done(client);
            }
            const sqlError = JSON.parse(JSON.stringify(err));
            sqlError.message = err.message;
            err = error.addData(err, {sqlError: sqlError, sql: sql, sqlParams: params});
            ERR(err, callback);
            return true;
        };
        if (handleError(err)) return;
        paramsToArray(sql, params, function(err, newSql, newParams) {
            if (err) err = error.addData(err, {sql: sql, sqlParams: params});
            if (ERR(err, callback)) return;
            client.query(newSql, newParams, function(err, result) {
                if (handleError(err)) return;
                done();
                debug('query() success', 'rowCount:', result.rowCount);
                callback(null, result);
            });
        });
    });
}

module.exports.queryAsync = promisify(module.exports.query);

/**
 * @param {string} sql - The SQL query to execute
 * @param {Params} params - The params for the query
 * @param {ResultsCallback} callback
 */
module.exports.queryOneRow = function(sql, params, callback) {
    debug('queryOneRow()', 'sql:', debugString(sql));
    debug('queryOneRow()', 'params:', debugParams(params));
    module.exports.query(sql, params, function(err, result) {
        if (ERR(err, callback)) return;
        if (result.rowCount !== 1) {
            const data = {sql: sql, sqlParams: params};
            return callback(error.makeWithData('Incorrect rowCount: ' + result.rowCount, data));
        }
        debug('queryOneRow() success', 'rowCount:', result.rowCount);
        callback(null, result);
    });
}

module.exports.queryOneRowAsync = promisify(module.exports.queryOneRow);

/**
 * @param {string} sql - The SQL query to execute
 * @param {Params} params - The params for the query
 * @param {ResultsCallback} callback
 */
module.exports.queryZeroOrOneRow = function(sql, params, callback) {
    debug('queryZeroOrOneRow()', 'sql:', debugString(sql));
    debug('queryZeroOrOneRow()', 'params:', debugParams(params));
    module.exports.query(sql, params, function(err, result) {
        if (ERR(err, callback)) return;
        if (result.rowCount > 1) {
            const data = {sql: sql, sqlParams: params};
            return callback(error.makeWithData('Incorrect rowCount: ' + result.rowCount, data));
        }
        debug('queryZeroOrOneRow() success', 'rowCount:', result.rowCount);
        callback(null, result);
    });
}

module.exports.queryZeroOrOneRowAsync = promisify(module.exports.queryZeroOrOneRow);

/**
 * @param {string} functionName
 * @param {Params} params
 * @param {ResultsCallback} callback
 */
module.exports.call = function(functionName, params, callback) {
    debug('call()', 'function:', functionName);
    debug('call()', 'params:', debugParams(params));
    const placeholders = _.map(_.range(1, params.length + 1), v => '$' + v).join();
    const sql = 'SELECT * FROM ' + functionName + '(' + placeholders + ')';
    module.exports.query(sql, params, function(err, result) {
        if (ERR(err, callback)) return;
        debug('call() success', 'rowCount:', result.rowCount);
        callback(null, result);
    });
}

module.exports.callAsync = promisify(module.exports.call);

/**
 * @param {string} functionName
 * @param {Params} params
 * @param {ResultsCallback} callback
 */
module.exports.callOneRow = function(functionName, params, callback) {
    debug('callOneRow()', 'function:', functionName);
    debug('callOneRow()', 'params:', debugParams(params));
    module.exports.call(functionName, params, function(err, result) {
        if (ERR(err, callback)) return;
        if (result.rowCount !== 1) {
            const data = {functionName: functionName, sqlParams: params};
            return callback(error.makeWithData('Incorrect rowCount: ' + result.rowCount, data));
        }
        debug('callOneRow() success', 'rowCount:', result.rowCount);
        callback(null, result);
    });
}

module.exports.callOneRowAsync = promisify(module.exports.callOneRow);

/**
 * @param {string} functionName
 * @param {Params} params
 * @param {ResultsCallback} callback
 */
module.exports.callZeroOrOneRow = function(functionName, params, callback) {
    debug('callZeroOrOneRow()', 'function:', functionName);
    debug('callZeroOrOneRow()', 'params:', debugParams(params));
    module.exports.call(functionName, params, function(err, result) {
        if (ERR(err, callback)) return;
        if (result.rowCount > 1) {
            const data = {functionName: functionName, sqlParams: params};
            return callback(error.makeWithData('Incorrect rowCount: ' + result.rowCount, data));
        }
        debug('callZeroOrOneRow() success', 'rowCount:', result.rowCount);
        callback(null, result);
    });
}

module.exports.callZeroOrOneRowAsync = promisify(module.exports.callZeroOrOneRow);

/**
 * @param { import("pg").PoolClient } client
 * @param {string} functionName
 * @param {Params} params
 * @param {ResultsCallback} callback
 */
module.exports.callWithClient = function(client, functionName, params, callback) {
    debug('callWithClient()', 'function:', functionName);
    debug('callWithClient()', 'params:', debugParams(params));
    const placeholders = _.map(_.range(1, params.length + 1), v => '$' + v).join();
    const sql = 'SELECT * FROM ' + functionName + '(' + placeholders + ')';
    module.exports.queryWithClient(client, sql, params, function(err, result) {
        if (ERR(err, callback)) return;
        debug('callWithClient() success', 'rowCount:', result.rowCount);
        callback(null, result);
    });
}

module.exports.callWithClientAsync = promisify(module.exports.callWithClient);

/**
 * @param { import("pg").PoolClient } client
 * @param {string} functionName
 * @param {Params} params
 * @param {ResultsCallback} callback
 */
module.exports.callWithClientOneRow = function(client, functionName, params, callback) {
    debug('callWithClientOneRow()', 'function:', functionName);
    debug('callWithClientOneRow()', 'params:', debugParams(params));
    const placeholders = _.map(_.range(1, params.length + 1), v => '$' + v).join();
    const sql = 'SELECT * FROM ' + functionName + '(' + placeholders + ')';
    module.exports.queryWithClient(client, sql, params, function(err, result) {
        if (ERR(err, callback)) return;
        if (result.rowCount !== 1) {
            const data = {functionName: functionName, sqlParams: params};
            return callback(error.makeWithData('Incorrect rowCount: ' + result.rowCount, data));
        }
        debug('callWithClientOneRow() success', 'rowCount:', result.rowCount);
        callback(null, result);
    });
}

module.exports.callWithClientOneRowAsync = promisify(module.exports.callWithClientOneRow);

/**
 * @param { import("pg").PoolClient } client
 * @param {string} functionName
 * @param {Params} params
 * @param {ResultsCallback} callback
 */
module.exports.callWithClientZeroOrOneRow = function(client, functionName, params, callback) {
    debug('callWithClientZeroOrOneRow()', 'function:', functionName);
    debug('callWithClientZeroOrOneRow()', 'params:', debugParams(params));
    const placeholders = _.map(_.range(1, params.length + 1), v => '$' + v).join();
    const sql = 'SELECT * FROM ' + functionName + '(' + placeholders + ')';
    module.exports.queryWithClient(client, sql, params, function(err, result) {
        if (ERR(err, callback)) return;
        if (result.rowCount > 1) {
            const data = {functionName: functionName, sqlParams: params};
            return callback(error.makeWithData('Incorrect rowCount: ' + result.rowCount, data));
        }
        debug('callWithClientZeroOrOneRow() success', 'rowCount:', result.rowCount);
        callback(null, result);
    });
}

module.exports.callWithClientZeroOrOneRowAsync = promisify(module.exports.callWithClientZeroOrOneRow);
