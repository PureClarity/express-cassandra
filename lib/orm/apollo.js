'use strict';

var tryRequire = require('try-require');

var dseDriver = tryRequire('dse-driver');

var async = require('async');
var util = require('util');
var _ = require('lodash');
var cql = dseDriver || require('cassandra-driver');

var BaseModel = require('./base_model');
var schemer = require('./apollo_schemer');
var buildError = require('./apollo_error.js');

var DEFAULT_REPLICATION_FACTOR = 1;

var noop = function noop() {};

var Apollo = function f(connection, options) {
  if (!connection) {
    throw buildError('model.validator.invalidconfig', 'Cassandra connection configuration undefined');
  }

  options = options || {};

  if (!options.defaultReplicationStrategy) {
    options.defaultReplicationStrategy = {
      class: 'SimpleStrategy',
      replication_factor: DEFAULT_REPLICATION_FACTOR
    };
  }

  this._options = options;
  this._models = {};
  this._keyspace = connection.keyspace;
  this._connection = connection;
  this._client = null;
};

Apollo.prototype = {
  _generate_model: function _generate_model(properties, callback) {
    var Model = function f() {
      for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }

      BaseModel.apply(this, Array.prototype.slice.call(args));
    };

    util.inherits(Model, BaseModel);

    Object.keys(BaseModel).forEach(function (key) {
      Model[key] = BaseModel[key];
    });

    Model._set_properties(properties);
    Model.syncDefinition(function (err, result) {
      if (typeof callback === 'function') {
        if (err) callback(err);else callback(null, result);
      }
    });

    return Model;
  },
  _get_system_client: function _get_system_client() {
    var connection = _.cloneDeep(this._connection);
    delete connection.keyspace;

    return new cql.Client(connection);
  },
  _generate_replication_text: function _generate_replication_text(replicationOption) {
    if (typeof replicationOption === 'string') {
      return replicationOption;
    }

    var properties = [];
    Object.keys(replicationOption).forEach(function (k) {
      properties.push(util.format("'%s': '%s'", k, replicationOption[k]));
    });

    return util.format('{%s}', properties.join(','));
  },
  _assert_keyspace: function _assert_keyspace(callback) {
    var self = this;
    var client = this._get_system_client();
    var keyspaceName = this._connection.keyspace;
    var replicationText = '';
    var options = this._options;

    var query = util.format("SELECT * FROM system_schema.keyspaces WHERE keyspace_name = '%s';", keyspaceName);
    client.execute(query, function (err, result) {
      if (err) {
        callback(err);
        return;
      }

      var createKeyspace = function createKeyspace() {
        replicationText = self._generate_replication_text(options.defaultReplicationStrategy);

        query = util.format('CREATE KEYSPACE IF NOT EXISTS "%s" WITH REPLICATION = %s;', keyspaceName, replicationText);
        client.execute(query, function (err1, result1) {
          client.shutdown(function () {
            callback(err1, result1);
          });
        });
      };

      var alterKeyspace = function alterKeyspace() {
        replicationText = self._generate_replication_text(options.defaultReplicationStrategy);

        query = util.format('ALTER KEYSPACE "%s" WITH REPLICATION = %s;', keyspaceName, replicationText);
        client.execute(query, function (err1, result1) {
          client.shutdown(function () {
            // eslint-disable-next-line no-console
            console.warn('WARN: KEYSPACE ALTERED! Run the `nodetool repair` command on each affected node.');
            callback(err1, result1);
          });
        });
      };

      if (result.rows && result.rows.length > 0) {
        var dbReplication = result.rows[0].replication;

        Object.keys(dbReplication).forEach(function (key) {
          if (key === 'class') dbReplication[key] = dbReplication[key].replace('org.apache.cassandra.locator.', '');else dbReplication[key] = parseInt(dbReplication[key], 10);
        });

        var ormReplication = options.defaultReplicationStrategy;
        Object.keys(ormReplication).forEach(function (key) {
          if (key === 'class') ormReplication[key] = ormReplication[key].replace('org.apache.cassandra.locator.', '');else ormReplication[key] = parseInt(ormReplication[key], 10);
        });

        if (_.isEqual(dbReplication, ormReplication)) {
          client.shutdown(function () {
            callback();
          });
        } else {
          alterKeyspace();
        }
      } else {
        createKeyspace();
      }
    });
  },
  _assert_user_defined_types: function _assert_user_defined_types(callback) {
    var client = this._define_connection;
    var options = this._options;
    var keyspace = this._keyspace;

    if (options.udts) {
      async.eachSeries(Object.keys(options.udts), function (udtKey, udtCallback) {
        var query = util.format("SELECT * FROM system_schema.types WHERE keyspace_name = '%s' AND type_name = '%s';", keyspace, udtKey);
        client.execute(query, function (err, result) {
          if (err) {
            udtCallback(err);
            return;
          }

          var createUDT = function createUDT() {
            var udtFields = [];
            Object.keys(options.udts[udtKey]).forEach(function (field) {
              udtFields.push(util.format('"%s" %s', field, options.udts[udtKey][field]));
            });
            query = util.format('CREATE TYPE IF NOT EXISTS "%s" (%s);', udtKey, udtFields.toString());
            client.execute(query, function (err1) {
              udtCallback(err1);
            });
          };

          if (result.rows && result.rows.length > 0) {
            var udtKeys = Object.keys(options.udts[udtKey]);
            var udtValues = _.values(options.udts[udtKey]);
            for (var i = 0; i < udtValues.length; i++) {
              udtValues[i] = udtValues[i].replace(/[\s]/g, '');
              if (udtValues[i].indexOf('<') > -1 && udtValues[i].indexOf('frozen<') !== 0) {
                udtValues[i] = util.format('frozen<%s>', udtValues[i]);
              }
            }

            var fieldNames = result.rows[0].field_names;
            var fieldTypes = result.rows[0].field_types;
            for (var _i = 0; _i < fieldTypes.length; _i++) {
              fieldTypes[_i] = fieldTypes[_i].replace(/[\s]/g, '');
              if (fieldTypes[_i].indexOf('<') > -1 && fieldTypes[_i].indexOf('frozen<') !== 0) {
                fieldTypes[_i] = util.format('frozen<%s>', fieldTypes[_i]);
              }
            }
            if (_.difference(udtKeys, fieldNames).length === 0 && _.difference(udtValues, fieldTypes).length === 0) {
              udtCallback();
            } else {
              throw new Error(util.format('User defined type "%s" already exists but does not match the udt definition. ' + 'Consider altering or droping the type.', udtKey));
            }
          } else {
            createUDT();
          }
        });
      }, function (err) {
        callback(err);
      });
    } else {
      callback();
    }
  },
  _assert_user_defined_functions: function _assert_user_defined_functions(callback) {
    var client = this._define_connection;
    var options = this._options;
    var keyspace = this._keyspace;

    if (options.udfs) {
      async.eachSeries(Object.keys(options.udfs), function (udfKey, udfCallback) {
        if (!options.udfs[udfKey].returnType) {
          throw new Error(util.format('No returnType defined for user defined function: %s', udfKey));
        }
        if (!options.udfs[udfKey].language) {
          throw new Error(util.format('No language defined for user defined function: %s', udfKey));
        }
        if (!options.udfs[udfKey].code) {
          throw new Error(util.format('No code defined for user defined function: %s', udfKey));
        }
        if (options.udfs[udfKey].inputs && !_.isPlainObject(options.udfs[udfKey].inputs)) {
          throw new Error(util.format('inputs must be an object for user defined function: %s', udfKey));
        }
        if (options.udfs[udfKey].inputs instanceof Array) {
          throw new Error(util.format('inputs must be an object, not an array for user defined function: %s', udfKey));
        }

        var query = util.format("SELECT * FROM system_schema.functions WHERE keyspace_name = '%s' AND function_name = '%s';", keyspace, udfKey.toLowerCase());
        client.execute(query, function (err, result) {
          if (err) {
            udfCallback(err);
            return;
          }

          var createUDF = function createUDF() {
            var udfInputs = [];
            if (options.udfs[udfKey].inputs) {
              Object.keys(options.udfs[udfKey].inputs).forEach(function (input) {
                udfInputs.push(util.format('%s %s', input, options.udfs[udfKey].inputs[input]));
              });
            }
            query = util.format("CREATE OR REPLACE FUNCTION %s (%s) CALLED ON NULL INPUT RETURNS %s LANGUAGE %s AS '%s';", udfKey, udfInputs.toString(), options.udfs[udfKey].returnType, options.udfs[udfKey].language, options.udfs[udfKey].code);
            client.execute(query, function (err1) {
              udfCallback(err1);
            });
          };

          if (result.rows && result.rows.length > 0) {
            var udfLanguage = options.udfs[udfKey].language;
            var resultLanguage = result.rows[0].language;

            var udfCode = options.udfs[udfKey].code;
            var resultCode = result.rows[0].body;

            var udfReturnType = options.udfs[udfKey].returnType;
            udfReturnType = udfReturnType.replace(/[\s]/g, '');
            if (udfReturnType.indexOf('<') > -1 && udfReturnType.indexOf('frozen<') !== 0) {
              udfReturnType = util.format('frozen<%s>', udfReturnType);
            }
            var resultReturnType = result.rows[0].return_type;
            resultReturnType = resultReturnType.replace(/[\s]/g, '');
            if (resultReturnType.indexOf('<') > -1 && resultReturnType.indexOf('frozen<') !== 0) {
              resultReturnType = util.format('frozen<%s>', resultReturnType);
            }

            var udfInputs = options.udfs[udfKey].inputs ? options.udfs[udfKey].inputs : {};
            var udfInputKeys = Object.keys(udfInputs);
            var udfInputValues = _.values(udfInputs);
            for (var i = 0; i < udfInputValues.length; i++) {
              udfInputValues[i] = udfInputValues[i].replace(/[\s]/g, '');
              if (udfInputValues[i].indexOf('<') > -1 && udfInputValues[i].indexOf('frozen<') !== 0) {
                udfInputValues[i] = util.format('frozen<%s>', udfInputValues[i]);
              }
            }
            var resultArgumentNames = result.rows[0].argument_names;
            var resultArgumentTypes = result.rows[0].argument_types;
            for (var _i2 = 0; _i2 < resultArgumentTypes.length; _i2++) {
              resultArgumentTypes[_i2] = resultArgumentTypes[_i2].replace(/[\s]/g, '');
              if (resultArgumentTypes[_i2].indexOf('<') > -1 && resultArgumentTypes[_i2].indexOf('frozen<') !== 0) {
                resultArgumentTypes[_i2] = util.format('frozen<%s>', resultArgumentTypes[_i2]);
              }
            }

            if (udfLanguage === resultLanguage && udfCode === resultCode && udfReturnType === resultReturnType && _.isEqual(udfInputKeys, resultArgumentNames) && _.isEqual(udfInputValues, resultArgumentTypes)) {
              udfCallback();
            } else {
              createUDF();
            }
          } else {
            createUDF();
          }
        });
      }, function (err) {
        callback(err);
      });
    } else {
      callback();
    }
  },
  _assert_user_defined_aggregates: function _assert_user_defined_aggregates(callback) {
    var client = this._define_connection;
    var options = this._options;
    var keyspace = this._keyspace;

    if (options.udas) {
      async.eachSeries(Object.keys(options.udas), function (udaKey, udaCallback) {
        if (!options.udas[udaKey].input_types) {
          throw new Error(util.format('No input_types defined for user defined function: %s', udaKey));
        }
        if (!(options.udas[udaKey].input_types instanceof Array)) {
          throw new Error(util.format('input_types must be an array for user defined function: %s', udaKey));
        }
        if (options.udas[udaKey].input_types.length < 1) {
          throw new Error(util.format('input_types array cannot be blank for user defined function: %s', udaKey));
        }
        if (!options.udas[udaKey].sfunc) {
          throw new Error(util.format('No sfunc defined for user defined aggregate: %s', udaKey));
        }
        if (!options.udas[udaKey].stype) {
          throw new Error(util.format('No stype defined for user defined aggregate: %s', udaKey));
        }
        if (!options.udas[udaKey].initcond) {
          options.udas[udaKey].initcond = null;
        }

        var query = util.format("SELECT * FROM system_schema.aggregates WHERE keyspace_name = '%s' AND aggregate_name = '%s';", keyspace, udaKey.toLowerCase());
        client.execute(query, function (err, result) {
          if (err) {
            udaCallback(err);
            return;
          }

          var createUDA = function createUDA() {
            query = util.format('CREATE OR REPLACE AGGREGATE %s (%s) SFUNC %s STYPE %s', udaKey, options.udas[udaKey].input_types.toString(), options.udas[udaKey].sfunc, options.udas[udaKey].stype);
            if (options.udas[udaKey].finalfunc) query += util.format(' FINALFUNC %s', options.udas[udaKey].finalfunc);
            query += util.format(' INITCOND %s;', options.udas[udaKey].initcond);

            client.execute(query, function (err1) {
              udaCallback(err1);
            });
          };

          if (result.rows && result.rows.length > 0) {
            var inputTypes = options.udas[udaKey].input_types;
            for (var i = 0; i < inputTypes.length; i++) {
              inputTypes[i] = inputTypes[i].replace(/[\s]/g, '');
              if (inputTypes[i].indexOf('<') > -1 && inputTypes[i].indexOf('frozen<') !== 0) {
                inputTypes[i] = util.format('frozen<%s>', inputTypes[i]);
              }
            }
            var sfunc = options.udas[udaKey].sfunc.toLowerCase();
            var stype = options.udas[udaKey].stype;
            stype = stype.replace(/[\s]/g, '');
            if (stype.indexOf('<') > -1 && stype.indexOf('frozen<') !== 0) {
              stype = util.format('frozen<%s>', stype);
            }
            var finalfunc = options.udas[udaKey].finalfunc;
            if (finalfunc) finalfunc = finalfunc.toLowerCase();else finalfunc = null;
            var initcond = options.udas[udaKey].initcond;
            if (initcond) initcond = initcond.replace(/[\s]/g, '');

            for (var _i3 = 0; _i3 < result.rows.length; _i3++) {
              var resultArgumentTypes = result.rows[_i3].argument_types;
              for (var j = 0; j < resultArgumentTypes.length; j++) {
                resultArgumentTypes[j] = resultArgumentTypes[j].replace(/[\s]/g, '');
                if (resultArgumentTypes[j].indexOf('<') > -1 && resultArgumentTypes[j].indexOf('frozen<') !== 0) {
                  resultArgumentTypes[j] = util.format('frozen<%s>', resultArgumentTypes[j]);
                }
              }

              var resultStateFunc = result.rows[_i3].state_func;
              var resultStateType = result.rows[_i3].state_type;
              resultStateType = resultStateType.replace(/[\s]/g, '');
              if (resultStateType.indexOf('<') > -1 && resultStateType.indexOf('frozen<') !== 0) {
                resultStateType = util.format('frozen<%s>', resultStateType);
              }

              var resultFinalFunc = result.rows[_i3].final_func;

              var resultInitcond = result.rows[_i3].initcond;
              if (resultInitcond) resultInitcond = resultInitcond.replace(/[\s]/g, '');

              if (sfunc === resultStateFunc && stype === resultStateType && finalfunc === resultFinalFunc && initcond === resultInitcond && _.isEqual(inputTypes, resultArgumentTypes)) {
                udaCallback();
                return;
              }
            }

            createUDA();
          } else {
            createUDA();
          }
        });
      }, function (err) {
        callback(err);
      });
    } else {
      callback();
    }
  },
  _set_client: function _set_client(client) {
    var _this = this;

    var defineConnectionOptions = _.cloneDeep(this._connection);

    this._client = client;
    this._define_connection = new cql.Client(defineConnectionOptions);

    // Reset connections on all models
    Object.keys(this._models).forEach(function (i) {
      _this._models[i]._properties.cql = _this._client;
      _this._models[i]._properties.define_connection = _this._define_connection;
    });
  },
  connect: function connect(callback) {
    var _this2 = this;

    var onUserDefinedAggregates = function onUserDefinedAggregates(err) {
      if (err) {
        callback(err);
        return;
      }
      callback(err, _this2);
    };

    var onUserDefinedFunctions = function f(err) {
      if (err) {
        callback(err);
        return;
      }
      try {
        this._assert_user_defined_aggregates(onUserDefinedAggregates.bind(this));
      } catch (e) {
        throw buildError('model.validator.invaliduda', e.message);
      }
    };

    var onUserDefinedTypes = function f(err) {
      if (err) {
        callback(err);
        return;
      }
      try {
        this._assert_user_defined_functions(onUserDefinedFunctions.bind(this));
      } catch (e) {
        throw buildError('model.validator.invalidudf', e.message);
      }
    };

    var onKeyspace = function f(err) {
      if (err) {
        callback(err);
        return;
      }
      this._set_client(new cql.Client(this._connection));
      try {
        this._assert_user_defined_types(onUserDefinedTypes.bind(this));
      } catch (e) {
        throw buildError('model.validator.invalidudt', e.message);
      }
    };

    if (this._keyspace && this._options.createKeyspace) {
      this._assert_keyspace(onKeyspace.bind(this));
    } else {
      onKeyspace.call(this);
    }
  },
  add_model: function add_model(modelName, modelSchema, callback) {
    if (!modelName || typeof modelName !== 'string') {
      throw buildError('model.validator.invalidschema', 'Model name must be a valid string');
    }

    try {
      schemer.validate_model_schema(modelSchema);
    } catch (e) {
      throw buildError('model.validator.invalidschema', e.message);
    }

    var baseProperties = {
      name: modelName,
      schema: modelSchema,
      keyspace: this._keyspace,
      define_connection: this._define_connection,
      cql: this._client,
      get_constructor: this.get_model.bind(this, modelName),
      connect: this.connect.bind(this),
      dropTableOnSchemaChange: this._options.dropTableOnSchemaChange,
      migration: this._options.migration,
      disableTTYConfirmation: this._options.disableTTYConfirmation
    };

    this._models[modelName] = this._generate_model(baseProperties, callback);
    return this._models[modelName];
  },
  get_model: function get_model(modelName) {
    return this._models[modelName] || null;
  },
  close: function close(callback) {
    callback = callback || noop;

    var clientsToShutdown = [];
    if (this.orm._client) {
      clientsToShutdown.push(this.orm._client.shutdown());
    }
    if (this.orm._define_connection) {
      clientsToShutdown.push(this.orm._define_connection.shutdown());
    }

    Promise.all(clientsToShutdown).then(function () {
      callback();
    }).catch(function (err) {
      callback(err);
    });
  }
};

module.exports = Apollo;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9vcm0vYXBvbGxvLmpzIl0sIm5hbWVzIjpbInRyeVJlcXVpcmUiLCJyZXF1aXJlIiwiZHNlRHJpdmVyIiwiYXN5bmMiLCJ1dGlsIiwiXyIsImNxbCIsIkJhc2VNb2RlbCIsInNjaGVtZXIiLCJidWlsZEVycm9yIiwiREVGQVVMVF9SRVBMSUNBVElPTl9GQUNUT1IiLCJub29wIiwiQXBvbGxvIiwiZiIsImNvbm5lY3Rpb24iLCJvcHRpb25zIiwiZGVmYXVsdFJlcGxpY2F0aW9uU3RyYXRlZ3kiLCJjbGFzcyIsInJlcGxpY2F0aW9uX2ZhY3RvciIsIl9vcHRpb25zIiwiX21vZGVscyIsIl9rZXlzcGFjZSIsImtleXNwYWNlIiwiX2Nvbm5lY3Rpb24iLCJfY2xpZW50IiwicHJvdG90eXBlIiwiX2dlbmVyYXRlX21vZGVsIiwicHJvcGVydGllcyIsImNhbGxiYWNrIiwiTW9kZWwiLCJhcmdzIiwiYXBwbHkiLCJBcnJheSIsInNsaWNlIiwiY2FsbCIsImluaGVyaXRzIiwiT2JqZWN0Iiwia2V5cyIsImZvckVhY2giLCJrZXkiLCJfc2V0X3Byb3BlcnRpZXMiLCJzeW5jRGVmaW5pdGlvbiIsImVyciIsInJlc3VsdCIsIl9nZXRfc3lzdGVtX2NsaWVudCIsImNsb25lRGVlcCIsIkNsaWVudCIsIl9nZW5lcmF0ZV9yZXBsaWNhdGlvbl90ZXh0IiwicmVwbGljYXRpb25PcHRpb24iLCJrIiwicHVzaCIsImZvcm1hdCIsImpvaW4iLCJfYXNzZXJ0X2tleXNwYWNlIiwic2VsZiIsImNsaWVudCIsImtleXNwYWNlTmFtZSIsInJlcGxpY2F0aW9uVGV4dCIsInF1ZXJ5IiwiZXhlY3V0ZSIsImNyZWF0ZUtleXNwYWNlIiwiZXJyMSIsInJlc3VsdDEiLCJzaHV0ZG93biIsImFsdGVyS2V5c3BhY2UiLCJjb25zb2xlIiwid2FybiIsInJvd3MiLCJsZW5ndGgiLCJkYlJlcGxpY2F0aW9uIiwicmVwbGljYXRpb24iLCJyZXBsYWNlIiwicGFyc2VJbnQiLCJvcm1SZXBsaWNhdGlvbiIsImlzRXF1YWwiLCJfYXNzZXJ0X3VzZXJfZGVmaW5lZF90eXBlcyIsIl9kZWZpbmVfY29ubmVjdGlvbiIsInVkdHMiLCJlYWNoU2VyaWVzIiwidWR0S2V5IiwidWR0Q2FsbGJhY2siLCJjcmVhdGVVRFQiLCJ1ZHRGaWVsZHMiLCJmaWVsZCIsInRvU3RyaW5nIiwidWR0S2V5cyIsInVkdFZhbHVlcyIsInZhbHVlcyIsImkiLCJpbmRleE9mIiwiZmllbGROYW1lcyIsImZpZWxkX25hbWVzIiwiZmllbGRUeXBlcyIsImZpZWxkX3R5cGVzIiwiZGlmZmVyZW5jZSIsIkVycm9yIiwiX2Fzc2VydF91c2VyX2RlZmluZWRfZnVuY3Rpb25zIiwidWRmcyIsInVkZktleSIsInVkZkNhbGxiYWNrIiwicmV0dXJuVHlwZSIsImxhbmd1YWdlIiwiY29kZSIsImlucHV0cyIsImlzUGxhaW5PYmplY3QiLCJ0b0xvd2VyQ2FzZSIsImNyZWF0ZVVERiIsInVkZklucHV0cyIsImlucHV0IiwidWRmTGFuZ3VhZ2UiLCJyZXN1bHRMYW5ndWFnZSIsInVkZkNvZGUiLCJyZXN1bHRDb2RlIiwiYm9keSIsInVkZlJldHVyblR5cGUiLCJyZXN1bHRSZXR1cm5UeXBlIiwicmV0dXJuX3R5cGUiLCJ1ZGZJbnB1dEtleXMiLCJ1ZGZJbnB1dFZhbHVlcyIsInJlc3VsdEFyZ3VtZW50TmFtZXMiLCJhcmd1bWVudF9uYW1lcyIsInJlc3VsdEFyZ3VtZW50VHlwZXMiLCJhcmd1bWVudF90eXBlcyIsIl9hc3NlcnRfdXNlcl9kZWZpbmVkX2FnZ3JlZ2F0ZXMiLCJ1ZGFzIiwidWRhS2V5IiwidWRhQ2FsbGJhY2siLCJpbnB1dF90eXBlcyIsInNmdW5jIiwic3R5cGUiLCJpbml0Y29uZCIsImNyZWF0ZVVEQSIsImZpbmFsZnVuYyIsImlucHV0VHlwZXMiLCJqIiwicmVzdWx0U3RhdGVGdW5jIiwic3RhdGVfZnVuYyIsInJlc3VsdFN0YXRlVHlwZSIsInN0YXRlX3R5cGUiLCJyZXN1bHRGaW5hbEZ1bmMiLCJmaW5hbF9mdW5jIiwicmVzdWx0SW5pdGNvbmQiLCJfc2V0X2NsaWVudCIsImRlZmluZUNvbm5lY3Rpb25PcHRpb25zIiwiX3Byb3BlcnRpZXMiLCJkZWZpbmVfY29ubmVjdGlvbiIsImNvbm5lY3QiLCJvblVzZXJEZWZpbmVkQWdncmVnYXRlcyIsIm9uVXNlckRlZmluZWRGdW5jdGlvbnMiLCJiaW5kIiwiZSIsIm1lc3NhZ2UiLCJvblVzZXJEZWZpbmVkVHlwZXMiLCJvbktleXNwYWNlIiwiYWRkX21vZGVsIiwibW9kZWxOYW1lIiwibW9kZWxTY2hlbWEiLCJ2YWxpZGF0ZV9tb2RlbF9zY2hlbWEiLCJiYXNlUHJvcGVydGllcyIsIm5hbWUiLCJzY2hlbWEiLCJnZXRfY29uc3RydWN0b3IiLCJnZXRfbW9kZWwiLCJkcm9wVGFibGVPblNjaGVtYUNoYW5nZSIsIm1pZ3JhdGlvbiIsImRpc2FibGVUVFlDb25maXJtYXRpb24iLCJjbG9zZSIsImNsaWVudHNUb1NodXRkb3duIiwib3JtIiwiUHJvbWlzZSIsImFsbCIsInRoZW4iLCJjYXRjaCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7O0FBQUEsSUFBTUEsYUFBYUMsUUFBUSxhQUFSLENBQW5COztBQUVBLElBQU1DLFlBQVlGLFdBQVcsWUFBWCxDQUFsQjs7QUFFQSxJQUFNRyxRQUFRRixRQUFRLE9BQVIsQ0FBZDtBQUNBLElBQU1HLE9BQU9ILFFBQVEsTUFBUixDQUFiO0FBQ0EsSUFBTUksSUFBSUosUUFBUSxRQUFSLENBQVY7QUFDQSxJQUFNSyxNQUFNSixhQUFhRCxRQUFRLGtCQUFSLENBQXpCOztBQUVBLElBQU1NLFlBQVlOLFFBQVEsY0FBUixDQUFsQjtBQUNBLElBQU1PLFVBQVVQLFFBQVEsa0JBQVIsQ0FBaEI7QUFDQSxJQUFNUSxhQUFhUixRQUFRLG1CQUFSLENBQW5COztBQUVBLElBQU1TLDZCQUE2QixDQUFuQzs7QUFFQSxJQUFNQyxPQUFPLFNBQVBBLElBQU8sR0FBTSxDQUFFLENBQXJCOztBQUVBLElBQU1DLFNBQVMsU0FBU0MsQ0FBVCxD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LElBQWxCLENBQXVCLEtBQUtzSCxHQUFMLENBQVNoSixPQUFULENBQWlCdUMsUUFBakIsRUFBdkI7QUFDRDtBQUNELFFBQUksS0FBS3lHLEdBQUwsQ0FBUzVGLGtCQUFiLEVBQWlDO0FBQy9CMkYsd0JBQWtCckgsSUFBbEIsQ0FBdUIsS0FBS3NILEdBQUwsQ0FBUzVGLGtCQUFULENBQTRCYixRQUE1QixFQUF2QjtBQUNEOztBQUVEMEcsWUFBUUMsR0FBUixDQUFZSCxpQkFBWixFQUNHSSxJQURILENBQ1EsWUFBTTtBQUNWL0k7QUFDRCxLQUhILEVBSUdnSixLQUpILENBSVMsVUFBQ2xJLEdBQUQsRUFBUztBQUNkZCxlQUFTYyxHQUFUO0FBQ0QsS0FOSDtBQU9EO0FBdGpCZ0IsQ0FBbkI7O0FBeWpCQW1JLE9BQU9DLE9BQVAsR0FBaUJsSyxNQUFqQiIsImZpbGUiOiJhcG9sbG8uanMiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCB0cnlSZXF1aXJlID0gcmVxdWlyZSgndHJ5LXJlcXVpcmUnKTtcblxuY29uc3QgZHNlRHJpdmVyID0gdHJ5UmVxdWlyZSgnZHNlLWRyaXZlcicpO1xuXG5jb25zdCBhc3luYyA9IHJlcXVpcmUoJ2FzeW5jJyk7XG5jb25zdCB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuY29uc3QgXyA9IHJlcXVpcmUoJ2xvZGFzaCcpO1xuY29uc3QgY3FsID0gZHNlRHJpdmVyIHx8IHJlcXVpcmUoJ2Nhc3NhbmRyYS1kcml2ZXInKTtcblxuY29uc3QgQmFzZU1vZGVsID0gcmVxdWlyZSgnLi9iYXNlX21vZGVsJyk7XG5jb25zdCBzY2hlbWVyID0gcmVxdWlyZSgnLi9hcG9sbG9fc2NoZW1lcicpO1xuY29uc3QgYnVpbGRFcnJvciA9IHJlcXVpcmUoJy4vYXBvbGxvX2Vycm9yLmpzJyk7XG5cbmNvbnN0IERFRkFVTFRfUkVQTElDQVRJT05fRkFDVE9SID0gMTtcblxuY29uc3Qgbm9vcCA9ICgpID0+IHt9O1xuXG5jb25zdCBBcG9sbG8gPSBmdW5jdGlvbiBmKGNvbm5lY3Rpb24sIG9wdGlvbnMpIHtcbiAgaWYgKCFjb25uZWN0aW9uKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnZhbGlkYXRvci5pbnZhbGlkY29uZmlnJywgJ0Nhc3NhbmRyYSBjb25uZWN0aW9uIGNvbmZpZ3VyYXRpb24gdW5kZWZpbmVkJykpO1xuICB9XG5cbiAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG5cbiAgaWYgKCFvcHRpb25zLmRlZmF1bHRSZXBsaWNhdGlvblN0cmF0ZWd5KSB7XG4gICAgb3B0aW9ucy5kZWZhdWx0UmVwbGljYXRpb25TdHJhdGVneSA9IHtcbiAgICAgIGNsYXNzOiAnU2ltcGxlU3RyYXRlZ3knLFxuICAgICAgcmVwbGljYXRpb25fZmFjdG9yOiBERUZBVUxUX1JFUExJQ0FUSU9OX0ZBQ1RPUixcbiAgICB9O1xuICB9XG5cbiAgdGhpcy5fb3B0aW9ucyA9IG9wdGlvbnM7XG4gIHRoaXMuX21vZGVscyA9IHt9O1xuICB0aGlzLl9rZXlzcGFjZSA9IGNvbm5lY3Rpb24ua2V5c3BhY2U7XG4gIHRoaXMuX2Nvbm5lY3Rpb24gPSBjb25uZWN0aW9uO1xuICB0aGlzLl9jbGllbnQgPSBudWxsO1xufTtcblxuQXBvbGxvLnByb3RvdHlwZSA9IHtcblxuICBfZ2VuZXJhdGVfbW9kZWwocHJvcGVydGllcywgY2FsbGJhY2spIHtcbiAgICBjb25zdCBNb2RlbCA9IGZ1bmN0aW9uIGYoLi4uYXJncykge1xuICAgICAgQmFzZU1vZGVsLmFwcGx5KHRoaXMsIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3MpKTtcbiAgICB9O1xuXG4gICAgdXRpbC5pbmhlcml0cyhNb2RlbCwgQmFzZU1vZGVsKTtcblxuICAgIE9iamVjdC5rZXlzKEJhc2VNb2RlbCkuZm9yRWFjaCgoa2V5KSA9PiB7XG4gICAgICBNb2RlbFtrZXldID0gQmFzZU1vZGVsW2tleV07XG4gICAgfSk7XG5cbiAgICBNb2RlbC5fc2V0X3Byb3BlcnRpZXMocHJvcGVydGllcyk7XG4gICAgTW9kZWwuc3luY0RlZmluaXRpb24oKGVyciwgcmVzdWx0KSA9PiB7XG4gICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGlmIChlcnIpIGNhbGxiYWNrKGVycik7XG4gICAgICAgIGVsc2UgY2FsbGJhY2sobnVsbCwgcmVzdWx0KTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiBNb2RlbDtcbiAgfSxcblxuICBfZ2V0X3N5c3RlbV9jbGllbnQoKSB7XG4gICAgY29uc3QgY29ubmVjdGlvbiA9IF8uY2xvbmVEZWVwKHRoaXMuX2Nvbm5lY3Rpb24pO1xuICAgIGRlbGV0ZSBjb25uZWN0aW9uLmtleXNwYWNlO1xuXG4gICAgcmV0dXJuIG5ldyBjcWwuQ2xpZW50KGNvbm5lY3Rpb24pO1xuICB9LFxuXG4gIF9nZW5lcmF0ZV9yZXBsaWNhdGlvbl90ZXh0KHJlcGxpY2F0aW9uT3B0aW9uKSB7XG4gICAgaWYgKHR5cGVvZiByZXBsaWNhdGlvbk9wdGlvbiA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHJldHVybiByZXBsaWNhdGlvbk9wdGlvbjtcbiAgICB9XG5cbiAgICBjb25zdCBwcm9wZXJ0aWVzID0gW107XG4gICAgT2JqZWN0LmtleXMocmVwbGljYXRpb25PcHRpb24pLmZvckVhY2goKGspID0+IHtcbiAgICAgIHByb3BlcnRpZXMucHVzaCh1dGlsLmZvcm1hdChcIiclcyc6ICclcydcIiwgaywgcmVwbGljYXRpb25PcHRpb25ba10pKTtcbiAgICB9KTtcblxuICAgIHJldHVybiB1dGlsLmZvcm1hdCgneyVzfScsIHByb3BlcnRpZXMuam9pbignLCcpKTtcbiAgfSxcblxuICBfYXNzZXJ0X2tleXNwYWNlKGNhbGxiYWNrKSB7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG4gICAgY29uc3QgY2xpZW50ID0gdGhpcy5fZ2V0X3N5c3RlbV9jbGllbnQoKTtcbiAgICBjb25zdCBrZXlzcGFjZU5hbWUgPSB0aGlzLl9jb25uZWN0aW9uLmtleXNwYWNlO1xuICAgIGxldCByZXBsaWNhdGlvblRleHQgPSAnJztcbiAgICBjb25zdCBvcHRpb25zID0gdGhpcy5fb3B0aW9ucztcblxuICAgIGxldCBxdWVyeSA9IHV0aWwuZm9ybWF0KFxuICAgICAgXCJTRUxFQ1QgKiBGUk9NIHN5c3RlbV9zY2hlbWEua2V5c3BhY2VzIFdIRVJFIGtleXNwYWNlX25hbWUgPSAnJXMnO1wiLFxuICAgICAga2V5c3BhY2VOYW1lLFxuICAgICk7XG4gICAgY2xpZW50LmV4ZWN1dGUocXVlcnksIChlcnIsIHJlc3VsdCkgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGNyZWF0ZUtleXNwYWNlID0gKCkgPT4ge1xuICAgICAgICByZXBsaWNhdGlvblRleHQgPSBzZWxmLl9nZW5lcmF0ZV9yZXBsaWNhdGlvbl90ZXh0KG9wdGlvbnMuZGVmYXVsdFJlcGxpY2F0aW9uU3RyYXRlZ3kpO1xuXG4gICAgICAgIHF1ZXJ5ID0gdXRpbC5mb3JtYXQoXG4gICAgICAgICAgJ0NSRUFURSBLRVlTUEFDRSBJRiBOT1QgRVhJU1RTIFwiJXNcIiBXSVRIIFJFUExJQ0FUSU9OID0gJXM7JyxcbiAgICAgICAgICBrZXlzcGFjZU5hbWUsXG4gICAgICAgICAgcmVwbGljYXRpb25UZXh0LFxuICAgICAgICApO1xuICAgICAgICBjbGllbnQuZXhlY3V0ZShxdWVyeSwgKGVycjEsIHJlc3VsdDEpID0+IHtcbiAgICAgICAgICBjbGllbnQuc2h1dGRvd24oKCkgPT4ge1xuICAgICAgICAgICAgY2FsbGJhY2soZXJyMSwgcmVzdWx0MSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgICAgfTtcblxuICAgICAgY29uc3QgYWx0ZXJLZXlzcGFjZSA9ICgpID0+IHtcbiAgICAgICAgcmVwbGljYXRpb25UZXh0ID0gc2VsZi5fZ2VuZXJhdGVfcmVwbGljYXRpb25fdGV4dChvcHRpb25zLmRlZmF1bHRSZXBsaWNhdGlvblN0cmF0ZWd5KTtcblxuICAgICAgICBxdWVyeSA9IHV0aWwuZm9ybWF0KFxuICAgICAgICAgICdBTFRFUiBLRVlTUEFDRSBcIiVzXCIgV0lUSCBSRVBMSUNBVElPTiA9ICVzOycsXG4gICAgICAgICAga2V5c3BhY2VOYW1lLFxuICAgICAgICAgIHJlcGxpY2F0aW9uVGV4dCxcbiAgICAgICAgKTtcbiAgICAgICAgY2xpZW50LmV4ZWN1dGUocXVlcnksIChlcnIxLCByZXN1bHQxKSA9PiB7XG4gICAgICAgICAgY2xpZW50LnNodXRkb3duKCgpID0+IHtcbiAgICAgICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICAgICAgICBjb25zb2xlLndhcm4oJ1dBUk46IEtFWVNQQUNFIEFMVEVSRUQhIFJ1biB0aGUgYG5vZGV0b29sIHJlcGFpcmAgY29tbWFuZCBvbiBlYWNoIGFmZmVjdGVkIG5vZGUuJyk7XG4gICAgICAgICAgICBjYWxsYmFjayhlcnIxLCByZXN1bHQxKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICB9O1xuXG4gICAgICBpZiAocmVzdWx0LnJvd3MgJiYgcmVzdWx0LnJvd3MubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zdCBkYlJlcGxpY2F0aW9uID0gcmVzdWx0LnJvd3NbMF0ucmVwbGljYXRpb247XG5cbiAgICAgICAgT2JqZWN0LmtleXMoZGJSZXBsaWNhdGlvbikuZm9yRWFjaCgoa2V5KSA9PiB7XG4gICAgICAgICAgaWYgKGtleSA9PT0gJ2NsYXNzJykgZGJSZXBsaWNhdGlvbltrZXldID0gZGJSZXBsaWNhdGlvbltrZXldLnJlcGxhY2UoJ29yZy5hcGFjaGUuY2Fzc2FuZHJhLmxvY2F0b3IuJywgJycpO1xuICAgICAgICAgIGVsc2UgZGJSZXBsaWNhdGlvbltrZXldID0gcGFyc2VJbnQoZGJSZXBsaWNhdGlvbltrZXldLCAxMCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IG9ybVJlcGxpY2F0aW9uID0gb3B0aW9ucy5kZWZhdWx0UmVwbGljYXRpb25TdHJhdGVneTtcbiAgICAgICAgT2JqZWN0LmtleXMob3JtUmVwbGljYXRpb24pLmZvckVhY2goKGtleSkgPT4ge1xuICAgICAgICAgIGlmIChrZXkgPT09ICdjbGFzcycpIG9ybVJlcGxpY2F0aW9uW2tleV0gPSBvcm1SZXBsaWNhdGlvbltrZXldLnJlcGxhY2UoJ29yZy5hcGFjaGUuY2Fzc2FuZHJhLmxvY2F0b3IuJywgJycpO1xuICAgICAgICAgIGVsc2Ugb3JtUmVwbGljYXRpb25ba2V5XSA9IHBhcnNlSW50KG9ybVJlcGxpY2F0aW9uW2tleV0sIDEwKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKF8uaXNFcXVhbChkYlJlcGxpY2F0aW9uLCBvcm1SZXBsaWNhdGlvbikpIHtcbiAgICAgICAgICBjbGllbnQuc2h1dGRvd24oKCkgPT4ge1xuICAgICAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBhbHRlcktleXNwYWNlKCk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNyZWF0ZUtleXNwYWNlKCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0sXG5cbiAgX2Fzc2VydF91c2VyX2RlZmluZWRfdHlwZXMoY2FsbGJhY2spIHtcbiAgICBjb25zdCBjbGllbnQgPSB0aGlzLl9kZWZpbmVfY29ubmVjdGlvbjtcbiAgICBjb25zdCBvcHRpb25zID0gdGhpcy5fb3B0aW9ucztcbiAgICBjb25zdCBrZXlzcGFjZSA9IHRoaXMuX2tleXNwYWNlO1xuXG4gICAgaWYgKG9wdGlvbnMudWR0cykge1xuICAgICAgYXN5bmMuZWFjaFNlcmllcyhPYmplY3Qua2V5cyhvcHRpb25zLnVkdHMpLCAodWR0S2V5LCB1ZHRDYWxsYmFjaykgPT4ge1xuICAgICAgICBsZXQgcXVlcnkgPSB1dGlsLmZvcm1hdChcbiAgICAgICAgICBcIlNFTEVDVCAqIEZST00gc3lzdGVtX3NjaGVtYS50eXBlcyBXSEVSRSBrZXlzcGFjZV9uYW1lID0gJyVzJyBBTkQgdHlwZV9uYW1lID0gJyVzJztcIixcbiAgICAgICAgICBrZXlzcGFjZSxcbiAgICAgICAgICB1ZHRLZXksXG4gICAgICAgICk7XG4gICAgICAgIGNsaWVudC5leGVjdXRlKHF1ZXJ5LCAoZXJyLCByZXN1bHQpID0+IHtcbiAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICB1ZHRDYWxsYmFjayhlcnIpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IGNyZWF0ZVVEVCA9ICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHVkdEZpZWxkcyA9IFtdO1xuICAgICAgICAgICAgT2JqZWN0LmtleXMob3B0aW9ucy51ZHRzW3VkdEtleV0pLmZvckVhY2goKGZpZWxkKSA9PiB7XG4gICAgICAgICAgICAgIHVkdEZpZWxkcy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICdcIiVzXCIgJXMnLFxuICAgICAgICAgICAgICAgIGZpZWxkLFxuICAgICAgICAgICAgICAgIG9wdGlvbnMudWR0c1t1ZHRLZXldW2ZpZWxkXSxcbiAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHF1ZXJ5ID0gdXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICdDUkVBVEUgVFlQRSBJRiBOT1QgRVhJU1RTIFwiJXNcIiAoJXMpOycsXG4gICAgICAgICAgICAgIHVkdEtleSxcbiAgICAgICAgICAgICAgdWR0RmllbGRzLnRvU3RyaW5nKCksXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgY2xpZW50LmV4ZWN1dGUocXVlcnksIChlcnIxKSA9PiB7XG4gICAgICAgICAgICAgIHVkdENhbGxiYWNrKGVycjEpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfTtcblxuICAgICAgICAgIGlmIChyZXN1bHQucm93cyAmJiByZXN1bHQucm93cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBjb25zdCB1ZHRLZXlzID0gT2JqZWN0LmtleXMob3B0aW9ucy51ZHRzW3VkdEtleV0pO1xuICAgICAgICAgICAgY29uc3QgdWR0VmFsdWVzID0gXy52YWx1ZXMob3B0aW9ucy51ZHRzW3VkdEtleV0pO1xuICAgICAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCB1ZHRWYWx1ZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgdWR0VmFsdWVzW2ldID0gdWR0VmFsdWVzW2ldLnJlcGxhY2UoL1tcXHNdL2csICcnKTtcbiAgICAgICAgICAgICAgaWYgKHVkdFZhbHVlc1tpXS5pbmRleE9mKCc8JykgPiAtMSAmJiB1ZHRWYWx1ZXNbaV0uaW5kZXhPZignZnJvemVuPCcpICE9PSAwKSB7XG4gICAgICAgICAgICAgICAgdWR0VmFsdWVzW2ldID0gdXRpbC5mb3JtYXQoJ2Zyb3plbjwlcz4nLCB1ZHRWYWx1ZXNbaV0pO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGZpZWxkTmFtZXMgPSByZXN1bHQucm93c1swXS5maWVsZF9uYW1lcztcbiAgICAgICAgICAgIGNvbnN0IGZpZWxkVHlwZXMgPSByZXN1bHQucm93c1swXS5maWVsZF90eXBlcztcbiAgICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZmllbGRUeXBlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICBmaWVsZFR5cGVzW2ldID0gZmllbGRUeXBlc1tpXS5yZXBsYWNlKC9bXFxzXS9nLCAnJyk7XG4gICAgICAgICAgICAgIGlmIChmaWVsZFR5cGVzW2ldLmluZGV4T2YoJzwnKSA+IC0xICYmIGZpZWxkVHlwZXNbaV0uaW5kZXhPZignZnJvemVuPCcpICE9PSAwKSB7XG4gICAgICAgICAgICAgICAgZmllbGRUeXBlc1tpXSA9IHV0aWwuZm9ybWF0KCdmcm96ZW48JXM+JywgZmllbGRUeXBlc1tpXSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChfLmRpZmZlcmVuY2UodWR0S2V5cywgZmllbGROYW1lcykubGVuZ3RoID09PSAwICYmIF8uZGlmZmVyZW5jZSh1ZHRWYWx1ZXMsIGZpZWxkVHlwZXMpLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICB1ZHRDYWxsYmFjaygpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAgICdVc2VyIGRlZmluZWQgdHlwZSBcIiVzXCIgYWxyZWFkeSBleGlzdHMgYnV0IGRvZXMgbm90IG1hdGNoIHRoZSB1ZHQgZGVmaW5pdGlvbi4gJyArXG4gICAgICAgICAgICAgICAgICAnQ29uc2lkZXIgYWx0ZXJpbmcgb3IgZHJvcGluZyB0aGUgdHlwZS4nLFxuICAgICAgICAgICAgICAgICAgdWR0S2V5LFxuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjcmVhdGVVRFQoKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfSwgKGVycikgPT4ge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNhbGxiYWNrKCk7XG4gICAgfVxuICB9LFxuXG4gIF9hc3NlcnRfdXNlcl9kZWZpbmVkX2Z1bmN0aW9ucyhjYWxsYmFjaykge1xuICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuX2RlZmluZV9jb25uZWN0aW9uO1xuICAgIGNvbnN0IG9wdGlvbnMgPSB0aGlzLl9vcHRpb25zO1xuICAgIGNvbnN0IGtleXNwYWNlID0gdGhpcy5fa2V5c3BhY2U7XG5cbiAgICBpZiAob3B0aW9ucy51ZGZzKSB7XG4gICAgICBhc3luYy5lYWNoU2VyaWVzKE9iamVjdC5rZXlzKG9wdGlvbnMudWRmcyksICh1ZGZLZXksIHVkZkNhbGxiYWNrKSA9PiB7XG4gICAgICAgIGlmICghb3B0aW9ucy51ZGZzW3VkZktleV0ucmV0dXJuVHlwZSkge1xuICAgICAgICAgIHRocm93IChuZXcgRXJyb3IoXG4gICAgICAgICAgICB1dGlsLmZvcm1hdCgnTm8gcmV0dXJuVHlwZSBkZWZpbmVkIGZvciB1c2VyIGRlZmluZWQgZnVuY3Rpb246ICVzJywgdWRmS2V5KSxcbiAgICAgICAgICApKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIW9wdGlvbnMudWRmc1t1ZGZLZXldLmxhbmd1YWdlKSB7XG4gICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAgIHV0aWwuZm9ybWF0KCdObyBsYW5ndWFnZSBkZWZpbmVkIGZvciB1c2VyIGRlZmluZWQgZnVuY3Rpb246ICVzJywgdWRmS2V5KSxcbiAgICAgICAgICApKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIW9wdGlvbnMudWRmc1t1ZGZLZXldLmNvZGUpIHtcbiAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgICAgdXRpbC5mb3JtYXQoJ05vIGNvZGUgZGVmaW5lZCBmb3IgdXNlciBkZWZpbmVkIGZ1bmN0aW9uOiAlcycsIHVkZktleSksXG4gICAgICAgICAgKSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdGlvbnMudWRmc1t1ZGZLZXldLmlucHV0cyAmJiAhXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMudWRmc1t1ZGZLZXldLmlucHV0cykpIHtcbiAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgICAgdXRpbC5mb3JtYXQoJ2lucHV0cyBtdXN0IGJlIGFuIG9iamVjdCBmb3IgdXNlciBkZWZpbmVkIGZ1bmN0aW9uOiAlcycsIHVkZktleSksXG4gICAgICAgICAgKSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdGlvbnMudWRmc1t1ZGZLZXldLmlucHV0cyBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAgIHV0aWwuZm9ybWF0KCdpbnB1dHMgbXVzdCBiZSBhbiBvYmplY3QsIG5vdCBhbiBhcnJheSBmb3IgdXNlciBkZWZpbmVkIGZ1bmN0aW9uOiAlcycsIHVkZktleSksXG4gICAgICAgICAgKSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcXVlcnkgPSB1dGlsLmZvcm1hdChcbiAgICAgICAgICBcIlNFTEVDVCAqIEZST00gc3lzdGVtX3NjaGVtYS5mdW5jdGlvbnMgV0hFUkUga2V5c3BhY2VfbmFtZSA9ICclcycgQU5EIGZ1bmN0aW9uX25hbWUgPSAnJXMnO1wiLFxuICAgICAgICAgIGtleXNwYWNlLFxuICAgICAgICAgIHVkZktleS50b0xvd2VyQ2FzZSgpLFxuICAgICAgICApO1xuICAgICAgICBjbGllbnQuZXhlY3V0ZShxdWVyeSwgKGVyciwgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgdWRmQ2FsbGJhY2soZXJyKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBjcmVhdGVVREYgPSAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB1ZGZJbnB1dHMgPSBbXTtcbiAgICAgICAgICAgIGlmIChvcHRpb25zLnVkZnNbdWRmS2V5XS5pbnB1dHMpIHtcbiAgICAgICAgICAgICAgT2JqZWN0LmtleXMob3B0aW9ucy51ZGZzW3VkZktleV0uaW5wdXRzKS5mb3JFYWNoKChpbnB1dCkgPT4ge1xuICAgICAgICAgICAgICAgIHVkZklucHV0cy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgJyVzICVzJyxcbiAgICAgICAgICAgICAgICAgIGlucHV0LFxuICAgICAgICAgICAgICAgICAgb3B0aW9ucy51ZGZzW3VkZktleV0uaW5wdXRzW2lucHV0XSxcbiAgICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBxdWVyeSA9IHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICBcIkNSRUFURSBPUiBSRVBMQUNFIEZVTkNUSU9OICVzICglcykgQ0FMTEVEIE9OIE5VTEwgSU5QVVQgUkVUVVJOUyAlcyBMQU5HVUFHRSAlcyBBUyAnJXMnO1wiLFxuICAgICAgICAgICAgICB1ZGZLZXksXG4gICAgICAgICAgICAgIHVkZklucHV0cy50b1N0cmluZygpLFxuICAgICAgICAgICAgICBvcHRpb25zLnVkZnNbdWRmS2V5XS5yZXR1cm5UeXBlLFxuICAgICAgICAgICAgICBvcHRpb25zLnVkZnNbdWRmS2V5XS5sYW5ndWFnZSxcbiAgICAgICAgICAgICAgb3B0aW9ucy51ZGZzW3VkZktleV0uY29kZSxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBjbGllbnQuZXhlY3V0ZShxdWVyeSwgKGVycjEpID0+IHtcbiAgICAgICAgICAgICAgdWRmQ2FsbGJhY2soZXJyMSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9O1xuXG4gICAgICAgICAgaWYgKHJlc3VsdC5yb3dzICYmIHJlc3VsdC5yb3dzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGNvbnN0IHVkZkxhbmd1YWdlID0gb3B0aW9ucy51ZGZzW3VkZktleV0ubGFuZ3VhZ2U7XG4gICAgICAgICAgICBjb25zdCByZXN1bHRMYW5ndWFnZSA9IHJlc3VsdC5yb3dzWzBdLmxhbmd1YWdlO1xuXG4gICAgICAgICAgICBjb25zdCB1ZGZDb2RlID0gb3B0aW9ucy51ZGZzW3VkZktleV0uY29kZTtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdENvZGUgPSByZXN1bHQucm93c1swXS5ib2R5O1xuXG4gICAgICAgICAgICBsZXQgdWRmUmV0dXJuVHlwZSA9IG9wdGlvbnMudWRmc1t1ZGZLZXldLnJldHVyblR5cGU7XG4gICAgICAgICAgICB1ZGZSZXR1cm5UeXBlID0gdWRmUmV0dXJuVHlwZS5yZXBsYWNlKC9bXFxzXS9nLCAnJyk7XG4gICAgICAgICAgICBpZiAodWRmUmV0dXJuVHlwZS5pbmRleE9mKCc8JykgPiAtMSAmJiB1ZGZSZXR1cm5UeXBlLmluZGV4T2YoJ2Zyb3plbjwnKSAhPT0gMCkge1xuICAgICAgICAgICAgICB1ZGZSZXR1cm5UeXBlID0gdXRpbC5mb3JtYXQoJ2Zyb3plbjwlcz4nLCB1ZGZSZXR1cm5UeXBlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGxldCByZXN1bHRSZXR1cm5UeXBlID0gcmVzdWx0LnJvd3NbMF0ucmV0dXJuX3R5cGU7XG4gICAgICAgICAgICByZXN1bHRSZXR1cm5UeXBlID0gcmVzdWx0UmV0dXJuVHlwZS5yZXBsYWNlKC9bXFxzXS9nLCAnJyk7XG4gICAgICAgICAgICBpZiAocmVzdWx0UmV0dXJuVHlwZS5pbmRleE9mKCc8JykgPiAtMSAmJiByZXN1bHRSZXR1cm5UeXBlLmluZGV4T2YoJ2Zyb3plbjwnKSAhPT0gMCkge1xuICAgICAgICAgICAgICByZXN1bHRSZXR1cm5UeXBlID0gdXRpbC5mb3JtYXQoJ2Zyb3plbjwlcz4nLCByZXN1bHRSZXR1cm5UeXBlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgdWRmSW5wdXRzID0gb3B0aW9ucy51ZGZzW3VkZktleV0uaW5wdXRzID8gb3B0aW9ucy51ZGZzW3VkZktleV0uaW5wdXRzIDoge307XG4gICAgICAgICAgICBjb25zdCB1ZGZJbnB1dEtleXMgPSBPYmplY3Qua2V5cyh1ZGZJbnB1dHMpO1xuICAgICAgICAgICAgY29uc3QgdWRmSW5wdXRWYWx1ZXMgPSBfLnZhbHVlcyh1ZGZJbnB1dHMpO1xuICAgICAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCB1ZGZJbnB1dFZhbHVlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICB1ZGZJbnB1dFZhbHVlc1tpXSA9IHVkZklucHV0VmFsdWVzW2ldLnJlcGxhY2UoL1tcXHNdL2csICcnKTtcbiAgICAgICAgICAgICAgaWYgKHVkZklucHV0VmFsdWVzW2ldLmluZGV4T2YoJzwnKSA+IC0xICYmIHVkZklucHV0VmFsdWVzW2ldLmluZGV4T2YoJ2Zyb3plbjwnKSAhPT0gMCkge1xuICAgICAgICAgICAgICAgIHVkZklucHV0VmFsdWVzW2ldID0gdXRpbC5mb3JtYXQoJ2Zyb3plbjwlcz4nLCB1ZGZJbnB1dFZhbHVlc1tpXSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdEFyZ3VtZW50TmFtZXMgPSByZXN1bHQucm93c1swXS5hcmd1bWVudF9uYW1lcztcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdEFyZ3VtZW50VHlwZXMgPSByZXN1bHQucm93c1swXS5hcmd1bWVudF90eXBlcztcbiAgICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcmVzdWx0QXJndW1lbnRUeXBlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICByZXN1bHRBcmd1bWVudFR5cGVzW2ldID0gcmVzdWx0QXJndW1lbnRUeXBlc1tpXS5yZXBsYWNlKC9bXFxzXS9nLCAnJyk7XG4gICAgICAgICAgICAgIGlmIChyZXN1bHRBcmd1bWVudFR5cGVzW2ldLmluZGV4T2YoJzwnKSA+IC0xICYmIHJlc3VsdEFyZ3VtZW50VHlwZXNbaV0uaW5kZXhPZignZnJvemVuPCcpICE9PSAwKSB7XG4gICAgICAgICAgICAgICAgcmVzdWx0QXJndW1lbnRUeXBlc1tpXSA9IHV0aWwuZm9ybWF0KCdmcm96ZW48JXM+JywgcmVzdWx0QXJndW1lbnRUeXBlc1tpXSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHVkZkxhbmd1YWdlID09PSByZXN1bHRMYW5ndWFnZSAmJlxuICAgICAgICAgICAgICB1ZGZDb2RlID09PSByZXN1bHRDb2RlICYmXG4gICAgICAgICAgICAgIHVkZlJldHVyblR5cGUgPT09IHJlc3VsdFJldHVyblR5cGUgJiZcbiAgICAgICAgICAgICAgXy5pc0VxdWFsKHVkZklucHV0S2V5cywgcmVzdWx0QXJndW1lbnROYW1lcykgJiZcbiAgICAgICAgICAgICAgXy5pc0VxdWFsKHVkZklucHV0VmFsdWVzLCByZXN1bHRBcmd1bWVudFR5cGVzKSkge1xuICAgICAgICAgICAgICB1ZGZDYWxsYmFjaygpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgY3JlYXRlVURGKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNyZWF0ZVVERigpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9LCAoZXJyKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2FsbGJhY2soKTtcbiAgICB9XG4gIH0sXG5cbiAgX2Fzc2VydF91c2VyX2RlZmluZWRfYWdncmVnYXRlcyhjYWxsYmFjaykge1xuICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuX2RlZmluZV9jb25uZWN0aW9uO1xuICAgIGNvbnN0IG9wdGlvbnMgPSB0aGlzLl9vcHRpb25zO1xuICAgIGNvbnN0IGtleXNwYWNlID0gdGhpcy5fa2V5c3BhY2U7XG5cbiAgICBpZiAob3B0aW9ucy51ZGFzKSB7XG4gICAgICBhc3luYy5lYWNoU2VyaWVzKE9iamVjdC5rZXlzKG9wdGlvbnMudWRhcyksICh1ZGFLZXksIHVkYUNhbGxiYWNrKSA9PiB7XG4gICAgICAgIGlmICghb3B0aW9ucy51ZGFzW3VkYUtleV0uaW5wdXRfdHlwZXMpIHtcbiAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgICAgdXRpbC5mb3JtYXQoJ05vIGlucHV0X3R5cGVzIGRlZmluZWQgZm9yIHVzZXIgZGVmaW5lZCBmdW5jdGlvbjogJXMnLCB1ZGFLZXkpLFxuICAgICAgICAgICkpO1xuICAgICAgICB9XG4gICAgICAgIGlmICghKG9wdGlvbnMudWRhc1t1ZGFLZXldLmlucHV0X3R5cGVzIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAgIHV0aWwuZm9ybWF0KCdpbnB1dF90eXBlcyBtdXN0IGJlIGFuIGFycmF5IGZvciB1c2VyIGRlZmluZWQgZnVuY3Rpb246ICVzJywgdWRhS2V5KSxcbiAgICAgICAgICApKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAob3B0aW9ucy51ZGFzW3VkYUtleV0uaW5wdXRfdHlwZXMubGVuZ3RoIDwgMSkge1xuICAgICAgICAgIHRocm93IChuZXcgRXJyb3IoXG4gICAgICAgICAgICB1dGlsLmZvcm1hdCgnaW5wdXRfdHlwZXMgYXJyYXkgY2Fubm90IGJlIGJsYW5rIGZvciB1c2VyIGRlZmluZWQgZnVuY3Rpb246ICVzJywgdWRhS2V5KSxcbiAgICAgICAgICApKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIW9wdGlvbnMudWRhc1t1ZGFLZXldLnNmdW5jKSB7XG4gICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAgIHV0aWwuZm9ybWF0KCdObyBzZnVuYyBkZWZpbmVkIGZvciB1c2VyIGRlZmluZWQgYWdncmVnYXRlOiAlcycsIHVkYUtleSksXG4gICAgICAgICAgKSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFvcHRpb25zLnVkYXNbdWRhS2V5XS5zdHlwZSkge1xuICAgICAgICAgIHRocm93IChuZXcgRXJyb3IoXG4gICAgICAgICAgICB1dGlsLmZvcm1hdCgnTm8gc3R5cGUgZGVmaW5lZCBmb3IgdXNlciBkZWZpbmVkIGFnZ3JlZ2F0ZTogJXMnLCB1ZGFLZXkpLFxuICAgICAgICAgICkpO1xuICAgICAgICB9XG4gICAgICAgIGlmICghb3B0aW9ucy51ZGFzW3VkYUtleV0uaW5pdGNvbmQpIHtcbiAgICAgICAgICBvcHRpb25zLnVkYXNbdWRhS2V5XS5pbml0Y29uZCA9IG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcXVlcnkgPSB1dGlsLmZvcm1hdChcbiAgICAgICAgICBcIlNFTEVDVCAqIEZST00gc3lzdGVtX3NjaGVtYS5hZ2dyZWdhdGVzIFdIRVJFIGtleXNwYWNlX25hbWUgPSAnJXMnIEFORCBhZ2dyZWdhdGVfbmFtZSA9ICclcyc7XCIsXG4gICAgICAgICAga2V5c3BhY2UsXG4gICAgICAgICAgdWRhS2V5LnRvTG93ZXJDYXNlKCksXG4gICAgICAgICk7XG4gICAgICAgIGNsaWVudC5leGVjdXRlKHF1ZXJ5LCAoZXJyLCByZXN1bHQpID0+IHtcbiAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICB1ZGFDYWxsYmFjayhlcnIpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IGNyZWF0ZVVEQSA9ICgpID0+IHtcbiAgICAgICAgICAgIHF1ZXJ5ID0gdXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICdDUkVBVEUgT1IgUkVQTEFDRSBBR0dSRUdBVEUgJXMgKCVzKSBTRlVOQyAlcyBTVFlQRSAlcycsXG4gICAgICAgICAgICAgIHVkYUtleSxcbiAgICAgICAgICAgICAgb3B0aW9ucy51ZGFzW3VkYUtleV0uaW5wdXRfdHlwZXMudG9TdHJpbmcoKSxcbiAgICAgICAgICAgICAgb3B0aW9ucy51ZGFzW3VkYUtleV0uc2Z1bmMsXG4gICAgICAgICAgICAgIG9wdGlvbnMudWRhc1t1ZGFLZXldLnN0eXBlLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmIChvcHRpb25zLnVkYXNbdWRhS2V5XS5maW5hbGZ1bmMpIHF1ZXJ5ICs9IHV0aWwuZm9ybWF0KCcgRklOQUxGVU5DICVzJywgb3B0aW9ucy51ZGFzW3VkYUtleV0uZmluYWxmdW5jKTtcbiAgICAgICAgICAgIHF1ZXJ5ICs9IHV0aWwuZm9ybWF0KCcgSU5JVENPTkQgJXM7Jywgb3B0aW9ucy51ZGFzW3VkYUtleV0uaW5pdGNvbmQpO1xuXG4gICAgICAgICAgICBjbGllbnQuZXhlY3V0ZShxdWVyeSwgKGVycjEpID0+IHtcbiAgICAgICAgICAgICAgdWRhQ2FsbGJhY2soZXJyMSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9O1xuXG4gICAgICAgICAgaWYgKHJlc3VsdC5yb3dzICYmIHJlc3VsdC5yb3dzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGNvbnN0IGlucHV0VHlwZXMgPSBvcHRpb25zLnVkYXNbdWRhS2V5XS5pbnB1dF90eXBlcztcbiAgICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgaW5wdXRUeXBlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICBpbnB1dFR5cGVzW2ldID0gaW5wdXRUeXBlc1tpXS5yZXBsYWNlKC9bXFxzXS9nLCAnJyk7XG4gICAgICAgICAgICAgIGlmIChpbnB1dFR5cGVzW2ldLmluZGV4T2YoJzwnKSA+IC0xICYmIGlucHV0VHlwZXNbaV0uaW5kZXhPZignZnJvemVuPCcpICE9PSAwKSB7XG4gICAgICAgICAgICAgICAgaW5wdXRUeXBlc1tpXSA9IHV0aWwuZm9ybWF0KCdmcm96ZW48JXM+JywgaW5wdXRUeXBlc1tpXSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHNmdW5jID0gb3B0aW9ucy51ZGFzW3VkYUtleV0uc2Z1bmMudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICAgIGxldCBzdHlwZSA9IG9wdGlvbnMudWRhc1t1ZGFLZXldLnN0eXBlO1xuICAgICAgICAgICAgc3R5cGUgPSBzdHlwZS5yZXBsYWNlKC9bXFxzXS9nLCAnJyk7XG4gICAgICAgICAgICBpZiAoc3R5cGUuaW5kZXhPZignPCcpID4gLTEgJiYgc3R5cGUuaW5kZXhPZignZnJvemVuPCcpICE9PSAwKSB7XG4gICAgICAgICAgICAgIHN0eXBlID0gdXRpbC5mb3JtYXQoJ2Zyb3plbjwlcz4nLCBzdHlwZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsZXQgZmluYWxmdW5jID0gb3B0aW9ucy51ZGFzW3VkYUtleV0uZmluYWxmdW5jO1xuICAgICAgICAgICAgaWYgKGZpbmFsZnVuYykgZmluYWxmdW5jID0gZmluYWxmdW5jLnRvTG93ZXJDYXNlKCk7XG4gICAgICAgICAgICBlbHNlIGZpbmFsZnVuYyA9IG51bGw7XG4gICAgICAgICAgICBsZXQgaW5pdGNvbmQgPSBvcHRpb25zLnVkYXNbdWRhS2V5XS5pbml0Y29uZDtcbiAgICAgICAgICAgIGlmIChpbml0Y29uZCkgaW5pdGNvbmQgPSBpbml0Y29uZC5yZXBsYWNlKC9bXFxzXS9nLCAnJyk7XG5cbiAgICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcmVzdWx0LnJvd3MubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgY29uc3QgcmVzdWx0QXJndW1lbnRUeXBlcyA9IHJlc3VsdC5yb3dzW2ldLmFyZ3VtZW50X3R5cGVzO1xuICAgICAgICAgICAgICBmb3IgKGxldCBqID0gMDsgaiA8IHJlc3VsdEFyZ3VtZW50VHlwZXMubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgICAgICAgICByZXN1bHRBcmd1bWVudFR5cGVzW2pdID0gcmVzdWx0QXJndW1lbnRUeXBlc1tqXS5yZXBsYWNlKC9bXFxzXS9nLCAnJyk7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdEFyZ3VtZW50VHlwZXNbal0uaW5kZXhPZignPCcpID4gLTEgJiYgcmVzdWx0QXJndW1lbnRUeXBlc1tqXS5pbmRleE9mKCdmcm96ZW48JykgIT09IDApIHtcbiAgICAgICAgICAgICAgICAgIHJlc3VsdEFyZ3VtZW50VHlwZXNbal0gPSB1dGlsLmZvcm1hdCgnZnJvemVuPCVzPicsIHJlc3VsdEFyZ3VtZW50VHlwZXNbal0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGNvbnN0IHJlc3VsdFN0YXRlRnVuYyA9IHJlc3VsdC5yb3dzW2ldLnN0YXRlX2Z1bmM7XG4gICAgICAgICAgICAgIGxldCByZXN1bHRTdGF0ZVR5cGUgPSByZXN1bHQucm93c1tpXS5zdGF0ZV90eXBlO1xuICAgICAgICAgICAgICByZXN1bHRTdGF0ZVR5cGUgPSByZXN1bHRTdGF0ZVR5cGUucmVwbGFjZSgvW1xcc10vZywgJycpO1xuICAgICAgICAgICAgICBpZiAocmVzdWx0U3RhdGVUeXBlLmluZGV4T2YoJzwnKSA+IC0xICYmIHJlc3VsdFN0YXRlVHlwZS5pbmRleE9mKCdmcm96ZW48JykgIT09IDApIHtcbiAgICAgICAgICAgICAgICByZXN1bHRTdGF0ZVR5cGUgPSB1dGlsLmZvcm1hdCgnZnJvemVuPCVzPicsIHJlc3VsdFN0YXRlVHlwZSk7XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBjb25zdCByZXN1bHRGaW5hbEZ1bmMgPSByZXN1bHQucm93c1tpXS5maW5hbF9mdW5jO1xuXG4gICAgICAgICAgICAgIGxldCByZXN1bHRJbml0Y29uZCA9IHJlc3VsdC5yb3dzW2ldLmluaXRjb25kO1xuICAgICAgICAgICAgICBpZiAocmVzdWx0SW5pdGNvbmQpIHJlc3VsdEluaXRjb25kID0gcmVzdWx0SW5pdGNvbmQucmVwbGFjZSgvW1xcc10vZywgJycpO1xuXG4gICAgICAgICAgICAgIGlmIChzZnVuYyA9PT0gcmVzdWx0U3RhdGVGdW5jICYmXG4gICAgICAgICAgICAgICAgc3R5cGUgPT09IHJlc3VsdFN0YXRlVHlwZSAmJlxuICAgICAgICAgICAgICAgIGZpbmFsZnVuYyA9PT0gcmVzdWx0RmluYWxGdW5jICYmXG4gICAgICAgICAgICAgICAgaW5pdGNvbmQgPT09IHJlc3VsdEluaXRjb25kICYmXG4gICAgICAgICAgICAgICAgXy5pc0VxdWFsKGlucHV0VHlwZXMsIHJlc3VsdEFyZ3VtZW50VHlwZXMpKSB7XG4gICAgICAgICAgICAgICAgdWRhQ2FsbGJhY2soKTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY3JlYXRlVURBKCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNyZWF0ZVVEQSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9LCAoZXJyKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2FsbGJhY2soKTtcbiAgICB9XG4gIH0sXG5cbiAgX3NldF9jbGllbnQoY2xpZW50KSB7XG4gICAgY29uc3QgZGVmaW5lQ29ubmVjdGlvbk9wdGlvbnMgPSBfLmNsb25lRGVlcCh0aGlzLl9jb25uZWN0aW9uKTtcblxuICAgIHRoaXMuX2NsaWVudCA9IGNsaWVudDtcbiAgICB0aGlzLl9kZWZpbmVfY29ubmVjdGlvbiA9IG5ldyBjcWwuQ2xpZW50KGRlZmluZUNvbm5lY3Rpb25PcHRpb25zKTtcblxuICAgIC8vIFJlc2V0IGNvbm5lY3Rpb25zIG9uIGFsbCBtb2RlbHNcbiAgICBPYmplY3Qua2V5cyh0aGlzLl9tb2RlbHMpLmZvckVhY2goKGkpID0+IHtcbiAgICAgIHRoaXMuX21vZGVsc1tpXS5fcHJvcGVydGllcy5jcWwgPSB0aGlzLl9jbGllbnQ7XG4gICAgICB0aGlzLl9tb2RlbHNbaV0uX3Byb3BlcnRpZXMuZGVmaW5lX2Nvbm5lY3Rpb24gPSB0aGlzLl9kZWZpbmVfY29ubmVjdGlvbjtcbiAgICB9KTtcbiAgfSxcblxuICBjb25uZWN0KGNhbGxiYWNrKSB7XG4gICAgY29uc3Qgb25Vc2VyRGVmaW5lZEFnZ3JlZ2F0ZXMgPSAoZXJyKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhbGxiYWNrKGVyciwgdGhpcyk7XG4gICAgfTtcblxuICAgIGNvbnN0IG9uVXNlckRlZmluZWRGdW5jdGlvbnMgPSBmdW5jdGlvbiBmKGVycikge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICB0aGlzLl9hc3NlcnRfdXNlcl9kZWZpbmVkX2FnZ3JlZ2F0ZXMob25Vc2VyRGVmaW5lZEFnZ3JlZ2F0ZXMuYmluZCh0aGlzKSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHVkYScsIGUubWVzc2FnZSkpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICBjb25zdCBvblVzZXJEZWZpbmVkVHlwZXMgPSBmdW5jdGlvbiBmKGVycikge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICB0aGlzLl9hc3NlcnRfdXNlcl9kZWZpbmVkX2Z1bmN0aW9ucyhvblVzZXJEZWZpbmVkRnVuY3Rpb25zLmJpbmQodGhpcykpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWR1ZGYnLCBlLm1lc3NhZ2UpKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgY29uc3Qgb25LZXlzcGFjZSA9IGZ1bmN0aW9uIGYoZXJyKSB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRoaXMuX3NldF9jbGllbnQobmV3IGNxbC5DbGllbnQodGhpcy5fY29ubmVjdGlvbikpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdGhpcy5fYXNzZXJ0X3VzZXJfZGVmaW5lZF90eXBlcyhvblVzZXJEZWZpbmVkVHlwZXMuYmluZCh0aGlzKSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHVkdCcsIGUubWVzc2FnZSkpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICBpZiAodGhpcy5fa2V5c3BhY2UgJiYgdGhpcy5fb3B0aW9ucy5jcmVhdGVLZXlzcGFjZSkge1xuICAgICAgdGhpcy5fYXNzZXJ0X2tleXNwYWNlKG9uS2V5c3BhY2UuYmluZCh0aGlzKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG9uS2V5c3BhY2UuY2FsbCh0aGlzKTtcbiAgICB9XG4gIH0sXG5cbiAgYWRkX21vZGVsKG1vZGVsTmFtZSwgbW9kZWxTY2hlbWEsIGNhbGxiYWNrKSB7XG4gICAgaWYgKCFtb2RlbE5hbWUgfHwgdHlwZW9mIChtb2RlbE5hbWUpICE9PSAnc3RyaW5nJykge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnZhbGlkYXRvci5pbnZhbGlkc2NoZW1hJywgJ01vZGVsIG5hbWUgbXVzdCBiZSBhIHZhbGlkIHN0cmluZycpKTtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgc2NoZW1lci52YWxpZGF0ZV9tb2RlbF9zY2hlbWEobW9kZWxTY2hlbWEpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHNjaGVtYScsIGUubWVzc2FnZSkpO1xuICAgIH1cblxuICAgIGNvbnN0IGJhc2VQcm9wZXJ0aWVzID0ge1xuICAgICAgbmFtZTogbW9kZWxOYW1lLFxuICAgICAgc2NoZW1hOiBtb2RlbFNjaGVtYSxcbiAgICAgIGtleXNwYWNlOiB0aGlzLl9rZXlzcGFjZSxcbiAgICAgIGRlZmluZV9jb25uZWN0aW9uOiB0aGlzLl9kZWZpbmVfY29ubmVjdGlvbixcbiAgICAgIGNxbDogdGhpcy5fY2xpZW50LFxuICAgICAgZ2V0X2NvbnN0cnVjdG9yOiB0aGlzLmdldF9tb2RlbC5iaW5kKHRoaXMsIG1vZGVsTmFtZSksXG4gICAgICBjb25uZWN0OiB0aGlzLmNvbm5lY3QuYmluZCh0aGlzKSxcbiAgICAgIGRyb3BUYWJsZU9uU2NoZW1hQ2hhbmdlOiB0aGlzLl9vcHRpb25zLmRyb3BUYWJsZU9uU2NoZW1hQ2hhbmdlLFxuICAgICAgbWlncmF0aW9uOiB0aGlzLl9vcHRpb25zLm1pZ3JhdGlvbixcbiAgICAgIGRpc2FibGVUVFlDb25maXJtYXRpb246IHRoaXMuX29wdGlvbnMuZGlzYWJsZVRUWUNvbmZpcm1hdGlvbixcbiAgICB9O1xuXG4gICAgdGhpcy5fbW9kZWxzW21vZGVsTmFtZV0gPSB0aGlzLl9nZW5lcmF0ZV9tb2RlbChiYXNlUHJvcGVydGllcywgY2FsbGJhY2spO1xuICAgIHJldHVybiB0aGlzLl9tb2RlbHNbbW9kZWxOYW1lXTtcbiAgfSxcblxuICBnZXRfbW9kZWwobW9kZWxOYW1lKSB7XG4gICAgcmV0dXJuIHRoaXMuX21vZGVsc1ttb2RlbE5hbWVdIHx8IG51bGw7XG4gIH0sXG5cbiAgY2xvc2UoY2FsbGJhY2spIHtcbiAgICBjYWxsYmFjayA9IGNhbGxiYWNrIHx8IG5vb3A7XG5cbiAgICBjb25zdCBjbGllbnRzVG9TaHV0ZG93biA9IFtdO1xuICAgIGlmICh0aGlzLm9ybS5fY2xpZW50KSB7XG4gICAgICBjbGllbnRzVG9TaHV0ZG93bi5wdXNoKHRoaXMub3JtLl9jbGllbnQuc2h1dGRvd24oKSk7XG4gICAgfVxuICAgIGlmICh0aGlzLm9ybS5fZGVmaW5lX2Nvbm5lY3Rpb24pIHtcbiAgICAgIGNsaWVudHNUb1NodXRkb3duLnB1c2godGhpcy5vcm0uX2RlZmluZV9jb25uZWN0aW9uLnNodXRkb3duKCkpO1xuICAgIH1cblxuICAgIFByb21pc2UuYWxsKGNsaWVudHNUb1NodXRkb3duKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICB9KTtcbiAgfSxcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gQXBvbGxvO1xuIl19