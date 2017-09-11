'use strict';

var tryRequire = require('try-require');

var dseDriver = tryRequire('dse-driver');

var util = require('util');
var cql = dseDriver || require('cassandra-driver');
var async = require('async');
var _ = require('lodash');
var deepDiff = require('deep-diff').diff;
var readlineSync = require('readline-sync');
var objectHash = require('object-hash');
var debug = require('debug')('express-cassandra');

var buildError = require('./apollo_error.js');
var schemer = require('./apollo_schemer');

var TYPE_MAP = require('./cassandra_types');

var checkDBTableName = function checkDBTableName(obj) {
  return typeof obj === 'string' && /^[a-zA-Z]+[a-zA-Z0-9_]*/.test(obj);
};

var BaseModel = function f(instanceValues) {
  instanceValues = instanceValues || {};
  var fieldValues = {};
  var fields = this.constructor._properties.schema.fields;
  var methods = this.constructor._properties.schema.methods || {};
  var model = this;

  var defaultSetter = function f1(propName, newValue) {
    if (this[propName] !== newValue) {
      model._modified[propName] = true;
    }
    this[propName] = newValue;
  };

  var defaultGetter = function f1(propName) {
    return this[propName];
  };

  this._modified = {};
  this._validators = {};

  for (var fieldsKeys = Object.keys(fields), i = 0, len = fieldsKeys.length; i < len; i++) {
    var propertyName = fieldsKeys[i];
    var field = fields[fieldsKeys[i]];

    this._validators[propertyName] = this.constructor._get_validators(propertyName);

    var setter = defaultSetter.bind(fieldValues, propertyName);
    var getter = defaultGetter.bind(fieldValues, propertyName);

    if (field.virtual && typeof field.virtual.set === 'function') {
      setter = field.virtual.set.bind(fieldValues);
    }

    if (field.virtual && typeof field.virtual.get === 'function') {
      getter = field.virtual.get.bind(fieldValues);
    }

    var descriptor = {
      enumerable: true,
      set: setter,
      get: getter
    };

    Object.defineProperty(this, propertyName, descriptor);
    if (!field.virtual) {
      this[propertyName] = instanceValues[propertyName];
    }
  }

  for (var methodNames = Object.keys(methods), _i = 0, _len = methodNames.length; _i < _len; _i++) {
    var methodName = methodNames[_i];
    var method = methods[methodName];
    this[methodName] = method;
  }
};

BaseModel._properties = {
  name: null,
  schema: null
};

BaseModel._set_properties = function f(properties) {
  var schema = properties.schema;
  var tableName = schema.table_name || properties.name;

  if (!checkDBTableName(tableName)) {
    throw buildError('model.tablecreation.invalidname', tableName);
  }

  var qualifiedTableName = util.format('"%s"."%s"', properties.keyspace, tableName);

  this._properties = properties;
  this._properties.table_name = tableName;
  this._properties.qualified_table_name = qualifiedTableName;
};

BaseModel._validate = function f(validators, value) {
  if (value == null || _.isPlainObject(value) && value.$db_function) return true;

  for (var v = 0; v < validators.length; v++) {
    if (typeof validators[v].validator === 'function') {
      if (!validators[v].validator(value)) {
        return validators[v].message;
      }
    }
  }
  return true;
};

BaseModel._get_generic_validator_message = function f(value, propName, fieldtype) {
  return util.format('Invalid Value: "%s" for Field: %s (Type: %s)', value, propName, fieldtype);
};

BaseModel._format_validator_rule = function f(rule) {
  if (typeof rule.validator !== 'function') {
    throw buildError('model.validator.invalidrule', 'Rule validator must be a valid function');
  }
  if (!rule.message) {
    rule.message = this._get_generic_validator_message;
  } else if (typeof rule.message === 'string') {
    rule.message = function f1(message) {
      return util.format(message);
    }.bind(null, rule.message);
  } else if (typeof rule.message !== 'function') {
    throw buildError('model.validator.invalidrule', 'Invalid validator message, must be string or a function');
  }

  return rule;
};

BaseModel._get_validators = function f(fieldname) {
  var _this = this;

  var fieldtype = void 0;
  try {
    fieldtype = schemer.get_field_type(this._properties.schema, fieldname);
  } catch (e) {
    throw buildError('model.validator.invalidschema', e.message);
  }

  var validators = [];
  var typeFieldValidator = TYPE_MAP.generic_type_validator(fieldtype);

  if (typeFieldValidator) validators.push(typeFieldValidator);

  var field = this._properties.schema.fields[fieldname];
  if (typeof field.rule !== 'undefined') {
    if (typeof field.rule === 'function') {
      field.rule = {
        validator: field.rule,
        message: this._get_generic_validator_message
      };
      validators.push(field.rule);
    } else {
      if (!_.isPlainObject(field.rule)) {
        throw buildError('model.validator.invalidrule', 'Validation rule must be a function or an object');
      }
      if (field.rule.validator) {
        validators.push(this._format_validator_rule(field.rule));
      } else if (Array.isArray(field.rule.validators)) {
        field.rule.validators.forEach(function (fieldrule) {
          validators.push(_this._format_validator_rule(fieldrule));
        });
      }
    }
  }

  return validators;
};

BaseModel._ask_confirmation = function f(message) {
  var permission = 'y';
  if (!this._properties.disableTTYConfirmation) {
    permission = readlineSync.question(message);
  }
  return permission;
};

BaseModel._ensure_connected = function f(callback) {
  if (!this._properties.cql) {
    this._properties.connect(callback);
  } else {
    callback();
  }
};

BaseModel._execute_definition_query = function f(query, params, callback) {
  var _this2 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing definition query: %s with params: %j', query, params);
    var properties = _this2._properties;
    var conn = properties.define_connection;
    conn.execute(query, params, { prepare: false, fetchSize: 0 }, callback);
  });
};

BaseModel._execute_batch = function f(queries, options, callback) {
  var _this3 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing batch queries: %j', queries);
    _this3._properties.cql.batch(queries, options, callback);
  });
};

BaseModel.execute_batch = function f(queries, options, callback) {
  if (arguments.length === 2) {
    callback = options;
    options = {};
  }

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  this._execute_batch(queries, options, callback);
};

BaseModel.get_cql_client = function f(callback) {
  var _this4 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    callback(null, _this4._properties.cql);
  });
};

BaseModel._create_table = function f(callback) {
  var _this5 = this;

  var properties = this._properties;
  var tableName = properties.table_name;
  var modelSchema = properties.schema;
  var dropTableOnSchemaChange = properties.dropTableOnSchemaChange;
  var migration = properties.migration;

  // backwards compatible change, dropTableOnSchemaChange will work like migration: 'drop'
  if (!migration) {
    if (dropTableOnSchemaChange) migration = 'drop';else migration = 'safe';
  }
  // always safe migrate if NODE_ENV==='production'
  if (process.env.NODE_ENV === 'production') migration = 'safe';

  // check for existence of table on DB and if it matches this model's schema
  this._get_db_table_schema(function (err, dbSchema) {
    if (err) {
      callback(err);
      return;
    }

    var afterCustomIndex = function afterCustomIndex(err1) {
      if (err1) {
        callback(buildError('model.tablecreation.dbindexcreate', err1));
        return;
      }
      // materialized view creation
      if (modelSchema.materialized_views) {
        async.eachSeries(Object.keys(modelSchema.materialized_views), function (viewName, next) {
          var matViewQuery = _this5._create_materialized_view_query(tableName, viewName, modelSchema.materialized_views[viewName]);
          _this5._execute_definition_query(matViewQuery, [], function (err2, result) {
            if (err2) next(buildError('model.tablecreation.matviewcreate', err2));else next(null, result);
          });
        }, callback);
      } else callback();
    };

    var afterDBIndex = function afterDBIndex(err1) {
      if (err1) {
        callback(buildError('model.tablecreation.dbindexcreate', err1));
        return;
      }
      // custom index creation
      if (modelSchema.custom_indexes) {
        async.eachSeries(modelSchema.custom_indexes, function (idx, next) {
          _this5._execute_definition_query(_this5._create_custom_index_query(tableName, idx), [], function (err2, result) {
            if (err2) next(err2);else next(null, result);
          });
        }, afterCustomIndex);
      } else if (modelSchema.custom_index) {
        var customIndexQuery = _this5._create_custom_index_query(tableName, modelSchema.custom_index);
        _this5._execute_definition_query(customIndexQuery, [], function (err2, result) {
          if (err2) afterCustomIndex(err2);else afterCustomIndex(null, result);
        });
      } else afterCustomIndex();
    };

    var afterDBCreate = function afterDBCreate(err1) {
      if (err1) {
        callback(buildError('model.tablecreation.dbcreate', err1));
        return;
      }
      // index creation
      if (modelSchema.indexes instanceof Array) {
        async.eachSeries(modelSchema.indexes, function (idx, next) {
          _this5._execute_definition_query(_this5._create_index_query(tableName, idx), [], function (err2, result) {
            if (err2) next(err2);else next(null, result);
          });
        }, afterDBIndex);
      } else afterDBIndex();
    };

    if (dbSchema) {
      var normalizedModelSchema = void 0;
      var normalizedDBSchema = void 0;

      try {
        normalizedModelSchema = schemer.normalize_model_schema(modelSchema);
        normalizedDBSchema = schemer.normalize_model_schema(dbSchema);
      } catch (e) {
        throw buildError('model.validator.invalidschema', e.message);
      }

      if (_.isEqual(normalizedModelSchema, normalizedDBSchema)) {
        callback();
      } else {
        var dropRecreateTable = function dropRecreateTable() {
          var permission = _this5._ask_confirmation(util.format('Migration: model schema changed for table "%s", drop table & recreate? (data will be lost!) (y/n): ', tableName));
          if (permission.toLowerCase() === 'y') {
            if (normalizedDBSchema.materialized_views) {
              var mviews = Object.keys(normalizedDBSchema.materialized_views);

              _this5.drop_mviews(mviews, function (err1) {
                if (err1) {
                  callback(buildError('model.tablecreation.matviewdrop', err1));
                  return;
                }

                _this5.drop_table(function (err2) {
                  if (err2) {
                    callback(buildError('model.tablecreation.dbdrop', err2));
                    return;
                  }
                  var createTableQuery = _this5._create_table_query(tableName, modelSchema);
                  _this5._execute_definition_query(createTableQuery, [], afterDBCreate);
                });
              });
            } else {
              _this5.drop_table(function (err1) {
                if (err1) {
                  callback(buildError('model.tablecreation.dbdrop', err1));
                  return;
                }
                var createTableQuery = _this5._create_table_query(tableName, modelSchema);
                _this5._execute_definition_query(createTableQuery, [], afterDBCreate);
              });
            }
          } else {
            callback(buildError('model.tablecreation.schemamismatch', tableName));
          }
        };

        var afterDBAlter = function afterDBAlter(err1) {
          if (err1) {
            if (err1.message !== 'break') callback(err1);
            return;
          }
          // it should create/drop indexes/custom_indexes/materialized_views that are added/removed in model schema
          // remove common indexes/custom_indexes/materialized_views from normalizedModelSchema and normalizedDBSchema
          // then drop all remaining indexes/custom_indexes/materialized_views from normalizedDBSchema
          // and add all remaining indexes/custom_indexes/materialized_views from normalizedModelSchema
          var addedIndexes = _.difference(normalizedModelSchema.indexes, normalizedDBSchema.indexes);
          var removedIndexes = _.difference(normalizedDBSchema.indexes, normalizedModelSchema.indexes);
          var removedIndexNames = [];
          removedIndexes.forEach(function (removedIndex) {
            removedIndexNames.push(dbSchema.index_names[removedIndex]);
          });

          var addedCustomIndexes = _.filter(normalizedModelSchema.custom_indexes, function (obj) {
            return !_.find(normalizedDBSchema.custom_indexes, obj);
          });
          var removedCustomIndexes = _.filter(normalizedDBSchema.custom_indexes, function (obj) {
            return !_.find(normalizedModelSchema.custom_indexes, obj);
          });
          removedCustomIndexes.forEach(function (removedIndex) {
            removedIndexNames.push(dbSchema.index_names[objectHash(removedIndex)]);
          });

          var addedMaterializedViews = _.filter(Object.keys(normalizedModelSchema.materialized_views), function (viewName) {
            return !_.find(normalizedDBSchema.materialized_views, normalizedModelSchema.materialized_views[viewName]);
          });
          var removedMaterializedViews = _.filter(Object.keys(normalizedDBSchema.materialized_views), function (viewName) {
            return !_.find(normalizedModelSchema.materialized_views, normalizedDBSchema.materialized_views[viewName]);
          });

          // remove altered materialized views
          if (removedMaterializedViews.length > 0) {
            var permission = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has removed materialized_views: %j, drop them? (y/n): ', tableName, removedMaterializedViews));
            if (permission.toLowerCase() !== 'y') {
              callback(buildError('model.tablecreation.schemamismatch', tableName));
              return;
            }
          }
          if (removedIndexNames.length > 0) {
            var _permission = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has removed indexes: %j, drop them? (y/n): ', tableName, removedIndexNames));
            if (_permission.toLowerCase() !== 'y') {
              callback(buildError('model.tablecreation.schemamismatch', tableName));
              return;
            }
          }

          _this5.drop_mviews(removedMaterializedViews, function (err2) {
            if (err2) {
              callback(buildError('model.tablecreation.matviewdrop', err2));
              return;
            }

            // remove altered indexes by index name
            _this5.drop_indexes(removedIndexNames, function (err3) {
              if (err3) {
                callback(buildError('model.tablecreation.dbindexdrop', err3));
                return;
              }

              // add altered indexes
              async.eachSeries(addedIndexes, function (idx, next) {
                _this5._execute_definition_query(_this5._create_index_query(tableName, idx), [], function (err4, result) {
                  if (err4) next(err4);else next(null, result);
                });
              }, function (err4) {
                if (err4) {
                  callback(buildError('model.tablecreation.dbindexcreate', err4));
                  return;
                }

                // add altered custom indexes
                async.eachSeries(addedCustomIndexes, function (idx, next) {
                  var customIndexQuery = _this5._create_custom_index_query(tableName, idx);
                  _this5._execute_definition_query(customIndexQuery, [], function (err5, result) {
                    if (err5) next(err5);else next(null, result);
                  });
                }, function (err5) {
                  if (err5) {
                    callback(buildError('model.tablecreation.dbindexcreate', err5));
                    return;
                  }

                  // add altered materialized_views
                  async.eachSeries(addedMaterializedViews, function (viewName, next) {
                    var matViewQuery = _this5._create_materialized_view_query(tableName, viewName, modelSchema.materialized_views[viewName]);
                    _this5._execute_definition_query(matViewQuery, [], function (err6, result) {
                      if (err6) next(buildError('model.tablecreation.matviewcreate', err6));else next(null, result);
                    });
                  }, callback);
                });
              });
            });
          });
        };

        var alterDBTable = function alterDBTable() {
          var differences = deepDiff(normalizedDBSchema.fields, normalizedModelSchema.fields);
          async.eachSeries(differences, function (diff, next) {
            var fieldName = diff.path[0];
            var alterFieldType = function alterFieldType() {
              var permission = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new type for field "%s", ' + 'alter table to update column type? (y/n): ', tableName, fieldName));
              if (permission.toLowerCase() === 'y') {
                _this5.alter_table('ALTER', fieldName, diff.rhs, function (err1, result) {
                  if (err1) next(buildError('model.tablecreation.dbalter', err1));else next(null, result);
                });
              } else {
                next(buildError('model.tablecreation.schemamismatch', tableName));
              }
            };

            var alterAddField = function alterAddField() {
              var type = '';
              if (diff.path.length > 1) {
                if (diff.path[1] === 'type') {
                  type = diff.rhs;
                  if (normalizedModelSchema.fields[fieldName].typeDef) {
                    type += normalizedModelSchema.fields[fieldName].typeDef;
                  }
                } else {
                  type = normalizedModelSchema.fields[fieldName].type;
                  type += diff.rhs;
                }
              } else {
                type = diff.rhs.type;
                if (diff.rhs.typeDef) type += diff.rhs.typeDef;
              }

              _this5.alter_table('ADD', fieldName, type, function (err1, result) {
                if (err1) next(buildError('model.tablecreation.dbalter', err1));else next(null, result);
              });
            };

            var alterRemoveField = function alterRemoveField(nextCallback) {
              // remove dependent indexes/custom_indexes/materialized_views,
              // update them in normalizedDBSchema, then alter
              var dependentIndexes = [];
              var pullIndexes = [];
              normalizedDBSchema.indexes.forEach(function (dbIndex) {
                var indexSplit = dbIndex.split(/[()]/g);
                var indexFieldName = '';
                if (indexSplit.length > 1) indexFieldName = indexSplit[1];else indexFieldName = indexSplit[0];
                if (indexFieldName === fieldName) {
                  dependentIndexes.push(dbSchema.index_names[dbIndex]);
                  pullIndexes.push(dbIndex);
                }
              });
              _.pullAll(normalizedDBSchema.indexes, pullIndexes);

              var pullCustomIndexes = [];
              normalizedDBSchema.custom_indexes.forEach(function (dbIndex) {
                if (dbIndex.on === fieldName) {
                  dependentIndexes.push(dbSchema.index_names[objectHash(dbIndex)]);
                  pullCustomIndexes.push(dbIndex);
                }
              });
              _.pullAll(normalizedDBSchema.custom_indexes, pullCustomIndexes);

              var dependentViews = [];
              Object.keys(normalizedDBSchema.materialized_views).forEach(function (dbViewName) {
                if (normalizedDBSchema.materialized_views[dbViewName].select.indexOf(fieldName) > -1) {
                  dependentViews.push(dbViewName);
                } else if (normalizedDBSchema.materialized_views[dbViewName].select[0] === '*') {
                  dependentViews.push(dbViewName);
                } else if (normalizedDBSchema.materialized_views[dbViewName].key.indexOf(fieldName) > -1) {
                  dependentViews.push(dbViewName);
                } else if (normalizedDBSchema.materialized_views[dbViewName].key[0] instanceof Array && normalizedDBSchema.materialized_views[dbViewName].key[0].indexOf(fieldName) > -1) {
                  dependentViews.push(dbViewName);
                }
              });
              dependentViews.forEach(function (viewName) {
                delete normalizedDBSchema.materialized_views[viewName];
              });

              _this5.drop_mviews(dependentViews, function (err1) {
                if (err1) {
                  nextCallback(buildError('model.tablecreation.matviewdrop', err1));
                  return;
                }

                _this5.drop_indexes(dependentIndexes, function (err2) {
                  if (err2) {
                    nextCallback(buildError('model.tablecreation.dbindexdrop', err2));
                    return;
                  }

                  _this5.alter_table('DROP', fieldName, '', function (err3, result) {
                    if (err3) nextCallback(buildError('model.tablecreation.dbalter', err3));else nextCallback(null, result);
                  });
                });
              });
            };

            if (diff.kind === 'N') {
              var permission = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has added field "%s", alter table to add column? (y/n): ', tableName, fieldName));
              if (permission.toLowerCase() === 'y') {
                alterAddField();
              } else {
                next(buildError('model.tablecreation.schemamismatch', tableName));
              }
            } else if (diff.kind === 'D') {
              var _permission2 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has removed field "%s", alter table to drop column? ' + '(column data will be lost & dependent indexes/views will be recreated!) (y/n): ', tableName, fieldName));
              if (_permission2.toLowerCase() === 'y') {
                alterRemoveField(next);
              } else {
                next(buildError('model.tablecreation.schemamismatch', tableName));
              }
            } else if (diff.kind === 'E') {
              // check if the alter field type is possible, otherwise try D and then N
              if (diff.path[1] === 'type') {
                if (diff.lhs === 'int' && diff.rhs === 'varint') {
                  // alter field type possible
                  alterFieldType();
                } else if (normalizedDBSchema.key.indexOf(fieldName) > 0) {
                  // check if field part of clustering key
                  // alter field type impossible
                  var _permission3 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new incompatible type for primary key field "%s", ' + 'proceed to recreate table? (y/n): ', tableName, fieldName));
                  if (_permission3.toLowerCase() === 'y') {
                    dropRecreateTable();
                    next(new Error('break'));
                  } else {
                    next(buildError('model.tablecreation.schemamismatch', tableName));
                  }
                } else if (['text', 'ascii', 'bigint', 'boolean', 'decimal', 'double', 'float', 'inet', 'int', 'timestamp', 'timeuuid', 'uuid', 'varchar', 'varint'].indexOf(diff.lhs) > -1 && diff.rhs === 'blob') {
                  // alter field type possible
                  alterFieldType();
                } else if (diff.lhs === 'timeuuid' && diff.rhs === 'uuid') {
                  // alter field type possible
                  alterFieldType();
                } else if (normalizedDBSchema.key[0].indexOf(fieldName) > -1) {
                  // check if field part of partition key
                  // alter field type impossible
                  var _permission4 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new incompatible type for primary key field "%s", ' + 'proceed to recreate table? (y/n): ', tableName, fieldName));
                  if (_permission4.toLowerCase() === 'y') {
                    dropRecreateTable();
                    next(new Error('break'));
                  } else {
                    next(buildError('model.tablecreation.schemamismatch', tableName));
                  }
                } else {
                  // alter type impossible
                  var _permission5 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new incompatible type for field "%s", drop column ' + 'and recreate? (column data will be lost & dependent indexes/views will be recreated!) (y/n): ', tableName, fieldName));
                  if (_permission5.toLowerCase() === 'y') {
                    alterRemoveField(function (err1) {
                      if (err1) next(err1);else alterAddField();
                    });
                  } else {
                    next(buildError('model.tablecreation.schemamismatch', tableName));
                  }
                }
              } else {
                // alter type impossible
                var _permission6 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new incompatible type for field "%s", drop column ' + 'and recreate? (column data will be lost & dependent indexes/views will be recreated!) (y/n): ', tableName, fieldName));
                if (_permission6.toLowerCase() === 'y') {
                  alterRemoveField(function (err1) {
                    if (err1) next(err1);else alterAddField();
                  });
                } else {
                  next(buildError('model.tablecreation.schemamismatch', tableName));
                }
              }
            } else {
              next();
            }
          }, afterDBAlter);
        };

        if (migration === 'alter') {
          // check if table can be altered to match schema
          if (_.isEqual(normalizedModelSchema.key, normalizedDBSchema.key) && _.isEqual(normalizedModelSchema.clustering_order, normalizedDBSchema.clustering_order)) {
            alterDBTable();
          } else {
            dropRecreateTable();
          }
        } else if (migration === 'drop') {
          dropRecreateTable();
        } else {
          callback(buildError('model.tablecreation.schemamismatch', tableName));
        }
      }
    } else {
      // if not existing, it's created
      var createTableQuery = _this5._create_table_query(tableName, modelSchema);
      _this5._execute_definition_query(createTableQuery, [], afterDBCreate);
    }
  });
};

BaseModel._create_table_query = function f(tableName, schema) {
  var rows = [];
  var fieldType = void 0;
  Object.keys(schema.fields).forEach(function (k) {
    if (schema.fields[k].virtual) {
      return;
    }
    var segment = '';
    fieldType = schemer.get_field_type(schema, k);
    if (schema.fields[k].typeDef) {
      segment = util.format('"%s" %s%s', k, fieldType, schema.fields[k].typeDef);
    } else {
      segment = util.format('"%s" %s', k, fieldType);
    }

    if (schema.fields[k].static) {
      segment += ' STATIC';
    }

    rows.push(segment);
  });

  var partitionKey = schema.key[0];
  var clusteringKey = schema.key.slice(1, schema.key.length);
  var clusteringOrder = [];

  for (var field = 0; field < clusteringKey.length; field++) {
    if (schema.clustering_order && schema.clustering_order[clusteringKey[field]] && schema.clustering_order[clusteringKey[field]].toLowerCase() === 'desc') {
      clusteringOrder.push(util.format('"%s" DESC', clusteringKey[field]));
    } else {
      clusteringOrder.push(util.format('"%s" ASC', clusteringKey[field]));
    }
  }

  var clusteringOrderQuery = '';
  if (clusteringOrder.length > 0) {
    clusteringOrderQuery = util.format(' WITH CLUSTERING ORDER BY (%s)', clusteringOrder.toString());
  }

  if (partitionKey instanceof Array) {
    partitionKey = partitionKey.map(function (v) {
      return util.format('"%s"', v);
    }).join(',');
  } else {
    partitionKey = util.format('"%s"', partitionKey);
  }

  if (clusteringKey.length) {
    clusteringKey = clusteringKey.map(function (v) {
      return util.format('"%s"', v);
    }).join(',');
    clusteringKey = util.format(',%s', clusteringKey);
  } else {
    clusteringKey = '';
  }

  var query = util.format('CREATE TABLE IF NOT EXISTS "%s" (%s , PRIMARY KEY((%s)%s))%s;', tableName, rows.join(' , '), partitionKey, clusteringKey, clusteringOrderQuery);

  return query;
};

BaseModel._create_materialized_view_query = function f(tableName, viewName, viewSchema) {
  var rows = [];

  for (var k = 0; k < viewSchema.select.length; k++) {
    if (viewSchema.select[k] === '*') rows.push(util.format('%s', viewSchema.select[k]));else rows.push(util.format('"%s"', viewSchema.select[k]));
  }

  var partitionKey = viewSchema.key[0];
  var clusteringKey = viewSchema.key.slice(1, viewSchema.key.length);
  var clusteringOrder = [];

  for (var field = 0; field < clusteringKey.length; field++) {
    if (viewSchema.clustering_order && viewSchema.clustering_order[clusteringKey[field]] && viewSchema.clustering_order[clusteringKey[field]].toLowerCase() === 'desc') {
      clusteringOrder.push(util.format('"%s" DESC', clusteringKey[field]));
    } else {
      clusteringOrder.push(util.format('"%s" ASC', clusteringKey[field]));
    }
  }

  var clusteringOrderQuery = '';
  if (clusteringOrder.length > 0) {
    clusteringOrderQuery = util.format(' WITH CLUSTERING ORDER BY (%s)', clusteringOrder.toString());
  }

  if (partitionKey instanceof Array) {
    partitionKey = partitionKey.map(function (v) {
      return util.format('"%s"', v);
    }).join(',');
  } else {
    partitionKey = util.format('"%s"', partitionKey);
  }

  if (clusteringKey.length) {
    clusteringKey = clusteringKey.map(function (v) {
      return util.format('"%s"', v);
    }).join(',');
    clusteringKey = util.format(',%s', clusteringKey);
  } else {
    clusteringKey = '';
  }

  var whereClause = partitionKey.split(',').join(' IS NOT NULL AND ');
  if (clusteringKey) whereClause += clusteringKey.split(',').join(' IS NOT NULL AND ');
  whereClause += ' IS NOT NULL';

  var query = util.format('CREATE MATERIALIZED VIEW IF NOT EXISTS "%s" AS SELECT %s FROM "%s" WHERE %s PRIMARY KEY((%s)%s)%s;', viewName, rows.join(' , '), tableName, whereClause, partitionKey, clusteringKey, clusteringOrderQuery);

  return query;
};

BaseModel._create_index_query = function f(tableName, indexName) {
  var query = void 0;
  var indexExpression = indexName.replace(/["\s]/g, '').split(/[()]/g);
  if (indexExpression.length > 1) {
    indexExpression[0] = indexExpression[0].toLowerCase();
    query = util.format('CREATE INDEX IF NOT EXISTS ON "%s" (%s("%s"));', tableName, indexExpression[0], indexExpression[1]);
  } else {
    query = util.format('CREATE INDEX IF NOT EXISTS ON "%s" ("%s");', tableName, indexExpression[0]);
  }

  return query;
};

BaseModel._create_custom_index_query = function f(tableName, customIndex) {
  var query = util.format('CREATE CUSTOM INDEX IF NOT EXISTS ON "%s" ("%s") USING \'%s\'', tableName, customIndex.on, customIndex.using);

  if (Object.keys(customIndex.options).length > 0) {
    query += ' WITH OPTIONS = {';
    Object.keys(customIndex.options).forEach(function (key) {
      query += util.format("'%s': '%s', ", key, customIndex.options[key]);
    });
    query = query.slice(0, -2);
    query += '}';
  }

  query += ';';

  return query;
};

BaseModel._get_db_table_schema = function f(callback) {
  var self = this;

  var tableName = this._properties.table_name;
  var keyspace = this._properties.keyspace;

  var query = 'SELECT * FROM system_schema.columns WHERE table_name = ? AND keyspace_name = ?;';

  self.execute_query(query, [tableName, keyspace], function (err, resultColumns) {
    if (err) {
      callback(buildError('model.tablecreation.dbschemaquery', err));
      return;
    }

    if (!resultColumns.rows || resultColumns.rows.length === 0) {
      callback(null, null);
      return;
    }

    var dbSchema = { fields: {}, typeMaps: {}, staticMaps: {} };

    for (var r = 0; r < resultColumns.rows.length; r++) {
      var row = resultColumns.rows[r];

      dbSchema.fields[row.column_name] = TYPE_MAP.extract_type(row.type);

      var typeMapDef = TYPE_MAP.extract_typeDef(row.type);
      if (typeMapDef.length > 0) {
        dbSchema.typeMaps[row.column_name] = typeMapDef;
      }

      if (row.kind === 'partition_key') {
        if (!dbSchema.key) dbSchema.key = [[]];
        dbSchema.key[0][row.position] = row.column_name;
      } else if (row.kind === 'clustering') {
        if (!dbSchema.key) dbSchema.key = [[]];
        if (!dbSchema.clustering_order) dbSchema.clustering_order = {};

        dbSchema.key[row.position + 1] = row.column_name;
        if (row.clustering_order && row.clustering_order.toLowerCase() === 'desc') {
          dbSchema.clustering_order[row.column_name] = 'DESC';
        } else {
          dbSchema.clustering_order[row.column_name] = 'ASC';
        }
      } else if (row.kind === 'static') {
        dbSchema.staticMaps[row.column_name] = true;
      }
    }

    query = 'SELECT * FROM system_schema.indexes WHERE table_name = ? AND keyspace_name = ?;';

    self.execute_query(query, [tableName, keyspace], function (err1, resultIndexes) {
      if (err1) {
        callback(buildError('model.tablecreation.dbschemaquery', err1));
        return;
      }

      for (var _r = 0; _r < resultIndexes.rows.length; _r++) {
        var _row = resultIndexes.rows[_r];

        // Indexes by elassandra do not have row.options.target, so we should just skip them
        if (_row.index_name && _row.options.target) {
          var indexOptions = _row.options;
          var target = indexOptions.target;
          target = target.replace(/["\s]/g, '');
          delete indexOptions.target;

          // keeping track of index names to drop index when needed
          if (!dbSchema.index_names) dbSchema.index_names = {};

          if (_row.kind === 'CUSTOM') {
            var using = indexOptions.class_name;
            delete indexOptions.class_name;

            if (!dbSchema.custom_indexes) dbSchema.custom_indexes = [];
            var customIndexObject = {
              on: target,
              using: using,
              options: indexOptions
            };
            dbSchema.custom_indexes.push(customIndexObject);
            dbSchema.index_names[objectHash(customIndexObject)] = _row.index_name;
          } else {
            if (!dbSchema.indexes) dbSchema.indexes = [];
            dbSchema.indexes.push(target);
            dbSchema.index_names[target] = _row.index_name;
          }
        }
      }

      query = 'SELECT view_name,base_table_name FROM system_schema.views WHERE keyspace_name=?;';

      self.execute_query(query, [keyspace], function (err2, resultViews) {
        if (err2) {
          callback(buildError('model.tablecreation.dbschemaquery', err2));
          return;
        }

        for (var _r2 = 0; _r2 < resultViews.rows.length; _r2++) {
          var _row2 = resultViews.rows[_r2];

          if (_row2.base_table_name === tableName) {
            if (!dbSchema.materialized_views) dbSchema.materialized_views = {};
            dbSchema.materialized_views[_row2.view_name] = {};
          }
        }

        if (dbSchema.materialized_views) {
          query = 'SELECT * FROM system_schema.columns WHERE keyspace_name=? and table_name IN ?;';

          self.execute_query(query, [keyspace, Object.keys(dbSchema.materialized_views)], function (err3, resultMatViews) {
            if (err3) {
              callback(buildError('model.tablecreation.dbschemaquery', err3));
              return;
            }

            for (var _r3 = 0; _r3 < resultMatViews.rows.length; _r3++) {
              var _row3 = resultMatViews.rows[_r3];

              if (!dbSchema.materialized_views[_row3.table_name].select) {
                dbSchema.materialized_views[_row3.table_name].select = [];
              }

              dbSchema.materialized_views[_row3.table_name].select.push(_row3.column_name);

              if (_row3.kind === 'partition_key') {
                if (!dbSchema.materialized_views[_row3.table_name].key) {
                  dbSchema.materialized_views[_row3.table_name].key = [[]];
                }

                dbSchema.materialized_views[_row3.table_name].key[0][_row3.position] = _row3.column_name;
              } else if (_row3.kind === 'clustering') {
                if (!dbSchema.materialized_views[_row3.table_name].key) {
                  dbSchema.materialized_views[_row3.table_name].key = [[]];
                }
                if (!dbSchema.materialized_views[_row3.table_name].clustering_order) {
                  dbSchema.materialized_views[_row3.table_name].clustering_order = {};
                }

                dbSchema.materialized_views[_row3.table_name].key[_row3.position + 1] = _row3.column_name;
                if (_row3.clustering_order && _row3.clustering_order.toLowerCase() === 'desc') {
                  dbSchema.materialized_views[_row3.table_name].clustering_order[_row3.column_name] = 'DESC';
                } else {
                  dbSchema.materialized_views[_row3.table_name].clustering_order[_row3.column_name] = 'ASC';
                }
              }
            }

            callback(null, dbSchema);
          });
        } else {
          callback(null, dbSchema);
        }
      });
    });
  });
};

BaseModel._execute_table_query = function f(query, params, options, callback) {
  if (arguments.length === 3) {
    callback = options;
    options = {};
  }

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var doExecuteQuery = function f1(doquery, docallback) {
    this.execute_query(doquery, params, options, docallback);
  }.bind(this, query);

  if (this.is_table_ready()) {
    doExecuteQuery(callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      doExecuteQuery(callback);
    });
  }
};

BaseModel._get_db_value_expression = function f(fieldname, fieldvalue) {
  var _this6 = this;

  if (fieldvalue == null || fieldvalue === cql.types.unset) {
    return { query_segment: '?', parameter: fieldvalue };
  }

  if (_.isPlainObject(fieldvalue) && fieldvalue.$db_function) {
    return fieldvalue.$db_function;
  }

  var fieldtype = schemer.get_field_type(this._properties.schema, fieldname);
  var validators = this._get_validators(fieldname);

  if (fieldvalue instanceof Array && fieldtype !== 'list' && fieldtype !== 'set' && fieldtype !== 'frozen') {
    var val = fieldvalue.map(function (v) {
      var dbVal = _this6._get_db_value_expression(fieldname, v);

      if (_.isPlainObject(dbVal) && dbVal.query_segment) return dbVal.parameter;
      return dbVal;
    });

    return { query_segment: '?', parameter: val };
  }

  var validationMessage = this._validate(validators, fieldvalue);
  if (validationMessage !== true) {
    throw buildError('model.validator.invalidvalue', validationMessage(fieldvalue, fieldname, fieldtype));
  }

  if (fieldtype === 'counter') {
    var counterQuerySegment = util.format('"%s"', fieldname);
    if (fieldvalue >= 0) counterQuerySegment += ' + ?';else counterQuerySegment += ' - ?';
    fieldvalue = Math.abs(fieldvalue);
    return { query_segment: counterQuerySegment, parameter: fieldvalue };
  }

  return { query_segment: '?', parameter: fieldvalue };
};

BaseModel._parse_query_object = function f(queryObject) {
  var _this7 = this;

  var queryRelations = [];
  var queryParams = [];

  Object.keys(queryObject).forEach(function (k) {
    if (k.indexOf('$') === 0) {
      // search queries based on lucene index or solr
      // escape all single quotes for queries in cassandra
      if (k === '$expr') {
        if (typeof queryObject[k].index === 'string' && typeof queryObject[k].query === 'string') {
          queryRelations.push(util.format("expr(%s,'%s')", queryObject[k].index, queryObject[k].query.replace(/'/g, "''")));
        } else {
          throw buildError('model.find.invalidexpr');
        }
      } else if (k === '$solr_query') {
        if (typeof queryObject[k] === 'string') {
          queryRelations.push(util.format("solr_query='%s'", queryObject[k].replace(/'/g, "''")));
        } else {
          throw buildError('model.find.invalidsolrquery');
        }
      }
      return;
    }

    var whereObject = queryObject[k];
    // Array of operators
    if (!(whereObject instanceof Array)) whereObject = [whereObject];

    for (var fk = 0; fk < whereObject.length; fk++) {
      var fieldRelation = whereObject[fk];

      var cqlOperators = {
        $eq: '=',
        $ne: '!=',
        $gt: '>',
        $lt: '<',
        $gte: '>=',
        $lte: '<=',
        $in: 'IN',
        $like: 'LIKE',
        $token: 'token',
        $contains: 'CONTAINS',
        $contains_key: 'CONTAINS KEY'
      };

      if (_.isPlainObject(fieldRelation)) {
        var validKeys = Object.keys(cqlOperators);
        var fieldRelationKeys = Object.keys(fieldRelation);
        for (var i = 0; i < fieldRelationKeys.length; i++) {
          if (validKeys.indexOf(fieldRelationKeys[i]) < 0) {
            // field relation key invalid
            fieldRelation = { $eq: fieldRelation };
            break;
          }
        }
      } else {
        fieldRelation = { $eq: fieldRelation };
      }

      var relKeys = Object.keys(fieldRelation);
      for (var rk = 0; rk < relKeys.length; rk++) {
        var firstKey = relKeys[rk];
        var firstValue = fieldRelation[firstKey];
        if (firstKey.toLowerCase() in cqlOperators) {
          firstKey = firstKey.toLowerCase();
          var op = cqlOperators[firstKey];

          if (firstKey === '$in' && !(firstValue instanceof Array)) throw buildError('model.find.invalidinop');
          if (firstKey === '$token' && !(firstValue instanceof Object)) throw buildError('model.find.invalidtoken');

          var whereTemplate = '"%s" %s %s';
          if (firstKey === '$token') {
            whereTemplate = 'token("%s") %s token(%s)';

            var tokenRelKeys = Object.keys(firstValue);
            for (var tokenRK = 0; tokenRK < tokenRelKeys.length; tokenRK++) {
              var tokenFirstKey = tokenRelKeys[tokenRK];
              var tokenFirstValue = firstValue[tokenFirstKey];
              tokenFirstKey = tokenFirstKey.toLowerCase();
              if (tokenFirstKey in cqlOperators && tokenFirstKey !== '$token' && tokenFirstKey !== '$in') {
                op = cqlOperators[tokenFirstKey];
              } else {
                throw buildError('model.find.invalidtokenop', tokenFirstKey);
              }

              if (tokenFirstValue instanceof Array) {
                var tokenKeys = k.split(',');
                for (var tokenIndex = 0; tokenIndex < tokenFirstValue.length; tokenIndex++) {
                  tokenKeys[tokenIndex] = tokenKeys[tokenIndex].trim();
                  var dbVal = _this7._get_db_value_expression(tokenKeys[tokenIndex], tokenFirstValue[tokenIndex]);
                  if (_.isPlainObject(dbVal) && dbVal.query_segment) {
                    tokenFirstValue[tokenIndex] = dbVal.query_segment;
                    queryParams.push(dbVal.parameter);
                  } else {
                    tokenFirstValue[tokenIndex] = dbVal;
                  }
                }
                queryRelations.push(util.format(whereTemplate, tokenKeys.join('","'), op, tokenFirstValue.toString()));
              } else {
                var _dbVal = _this7._get_db_value_expression(k, tokenFirstValue);
                if (_.isPlainObject(_dbVal) && _dbVal.query_segment) {
                  queryRelations.push(util.format(whereTemplate, k, op, _dbVal.query_segment));
                  queryParams.push(_dbVal.parameter);
                } else {
                  queryRelations.push(util.format(whereTemplate, k, op, _dbVal));
                }
              }
            }
          } else if (firstKey === '$contains') {
            var fieldtype1 = schemer.get_field_type(_this7._properties.schema, k);
            if (['map', 'list', 'set', 'frozen'].indexOf(fieldtype1) >= 0) {
              if (fieldtype1 === 'map' && _.isPlainObject(firstValue) && Object.keys(firstValue).length === 1) {
                queryRelations.push(util.format('"%s"[%s] %s %s', k, '?', '=', '?'));
                queryParams.push(Object.keys(firstValue)[0]);
                queryParams.push(firstValue[Object.keys(firstValue)[0]]);
              } else {
                queryRelations.push(util.format(whereTemplate, k, op, '?'));
                queryParams.push(firstValue);
              }
            } else {
              throw buildError('model.find.invalidcontainsop');
            }
          } else if (firstKey === '$contains_key') {
            var fieldtype2 = schemer.get_field_type(_this7._properties.schema, k);
            if (['map'].indexOf(fieldtype2) >= 0) {
              queryRelations.push(util.format(whereTemplate, k, op, '?'));
              queryParams.push(firstValue);
            } else {
              throw buildError('model.find.invalidcontainskeyop');
            }
          } else {
            var _dbVal2 = _this7._get_db_value_expression(k, firstValue);
            if (_.isPlainObject(_dbVal2) && _dbVal2.query_segment) {
              queryRelations.push(util.format(whereTemplate, k, op, _dbVal2.query_segment));
              queryParams.push(_dbVal2.parameter);
            } else {
              queryRelations.push(util.format(whereTemplate, k, op, _dbVal2));
            }
          }
        } else {
          throw buildError('model.find.invalidop', firstKey);
        }
      }
    }
  });

  return {
    queryRelations: queryRelations,
    queryParams: queryParams
  };
};

BaseModel._create_where_clause = function f(queryObject) {
  var parsedObject = this._parse_query_object(queryObject);
  var whereClause = {};
  if (parsedObject.queryRelations.length > 0) {
    whereClause.query = util.format('WHERE %s', parsedObject.queryRelations.join(' AND '));
  } else {
    whereClause.query = '';
  }
  whereClause.params = parsedObject.queryParams;
  return whereClause;
};

BaseModel._create_if_clause = function f(queryObject) {
  var parsedObject = this._parse_query_object(queryObject);
  var ifClause = {};
  if (parsedObject.queryRelations.length > 0) {
    ifClause.query = util.format('IF %s', parsedObject.queryRelations.join(' AND '));
  } else {
    ifClause.query = '';
  }
  ifClause.params = parsedObject.queryParams;
  return ifClause;
};

BaseModel._create_find_query = function f(queryObject, options) {
  var orderKeys = [];
  var limit = null;

  Object.keys(queryObject).forEach(function (k) {
    var queryItem = queryObject[k];
    if (k.toLowerCase() === '$orderby') {
      if (!(queryItem instanceof Object)) {
        throw buildError('model.find.invalidorder');
      }
      var orderItemKeys = Object.keys(queryItem);

      for (var i = 0; i < orderItemKeys.length; i++) {
        var cqlOrderDirection = { $asc: 'ASC', $desc: 'DESC' };
        if (orderItemKeys[i].toLowerCase() in cqlOrderDirection) {
          var orderFields = queryItem[orderItemKeys[i]];

          if (!(orderFields instanceof Array)) orderFields = [orderFields];

          for (var j = 0; j < orderFields.length; j++) {
            orderKeys.push(util.format('"%s" %s', orderFields[j], cqlOrderDirection[orderItemKeys[i]]));
          }
        } else {
          throw buildError('model.find.invalidordertype', orderItemKeys[i]);
        }
      }
    } else if (k.toLowerCase() === '$limit') {
      if (typeof queryItem !== 'number') throw buildError('model.find.limittype');
      limit = queryItem;
    }
  });

  var whereClause = this._create_where_clause(queryObject);

  var select = '*';
  if (options.select && _.isArray(options.select) && options.select.length > 0) {
    var selectArray = [];
    for (var i = 0; i < options.select.length; i++) {
      // separate the aggregate function and the column name if select is an aggregate function
      var selection = options.select[i].split(/[( )]/g).filter(function (e) {
        return e;
      });
      if (selection.length === 1) {
        selectArray.push(util.format('"%s"', selection[0]));
      } else if (selection.length === 2 || selection.length === 4) {
        var functionClause = util.format('%s("%s")', selection[0], selection[1]);
        if (selection[2]) functionClause += util.format(' %s', selection[2]);
        if (selection[3]) functionClause += util.format(' %s', selection[3]);

        selectArray.push(functionClause);
      } else if (selection.length === 3) {
        selectArray.push(util.format('"%s" %s %s', selection[0], selection[1], selection[2]));
      } else {
        selectArray.push('*');
      }
    }
    select = selectArray.join(',');
  }

  var query = util.format('SELECT %s %s FROM "%s" %s %s %s', options.distinct ? 'DISTINCT' : '', select, options.materialized_view ? options.materialized_view : this._properties.table_name, whereClause.query, orderKeys.length ? util.format('ORDER BY %s', orderKeys.join(', ')) : ' ', limit ? util.format('LIMIT %s', limit) : ' ');

  if (options.allow_filtering) query += ' ALLOW FILTERING;';else query += ';';

  return { query: query, params: whereClause.params };
};

BaseModel.get_table_name = function f() {
  return this._properties.table_name;
};

BaseModel.is_table_ready = function f() {
  return this._ready === true;
};

BaseModel.init = function f(options, callback) {
  if (!callback) {
    callback = options;
    options = undefined;
  }

  this._ready = true;
  callback();
};

BaseModel.syncDefinition = function f(callback) {
  var _this8 = this;

  var afterCreate = function afterCreate(err, result) {
    if (err) callback(err);else {
      _this8._ready = true;
      callback(null, result);
    }
  };

  this._create_table(afterCreate);
};

BaseModel.execute_query = function f(query, params, options, callback) {
  var _this9 = this;

  if (arguments.length === 3) {
    callback = options;
    options = {};
  }

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing query: %s with params: %j', query, params);
    _this9._properties.cql.execute(query, params, options, function (err1, result) {
      if (err1 && err1.code === 8704) {
        _this9._execute_definition_query(query, params, callback);
      } else {
        callback(err1, result);
      }
    });
  });
};

BaseModel.execute_eachRow = function f(query, params, options, onReadable, callback) {
  var _this10 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing eachRow query: %s with params: %j', query, params);
    _this10._properties.cql.eachRow(query, params, options, onReadable, callback);
  });
};

BaseModel._execute_table_eachRow = function f(query, params, options, onReadable, callback) {
  var _this11 = this;

  if (this.is_table_ready()) {
    this.execute_eachRow(query, params, options, onReadable, callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      _this11.execute_eachRow(query, params, options, onReadable, callback);
    });
  }
};

BaseModel.eachRow = function f(queryObject, options, onReadable, callback) {
  var _this12 = this;

  if (arguments.length === 3) {
    var cb = onReadable;
    onReadable = options;
    callback = cb;
    options = {};
  }
  if (typeof onReadable !== 'function') {
    throw buildError('model.find.eachrowerror', 'no valid onReadable function was provided');
  }
  if (typeof callback !== 'function') {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  options.return_query = true;
  var selectQuery = this.find(queryObject, options);

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  this._execute_table_eachRow(selectQuery.query, selectQuery.params, queryOptions, function (n, row) {
    if (!options.raw) {
      var ModelConstructor = _this12._properties.get_constructor();
      row = new ModelConstructor(row);
      row._modified = {};
    }
    onReadable(n, row);
  }, function (err, result) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    callback(err, result);
  });
};

BaseModel.execute_stream = function f(query, params, options, onReadable, callback) {
  var _this13 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing stream query: %s with params: %j', query, params);
    _this13._properties.cql.stream(query, params, options).on('readable', onReadable).on('end', callback);
  });
};

BaseModel._execute_table_stream = function f(query, params, options, onReadable, callback) {
  var _this14 = this;

  if (this.is_table_ready()) {
    this.execute_stream(query, params, options, onReadable, callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      _this14.execute_stream(query, params, options, onReadable, callback);
    });
  }
};

BaseModel.stream = function f(queryObject, options, onReadable, callback) {
  if (arguments.length === 3) {
    var cb = onReadable;
    onReadable = options;
    callback = cb;
    options = {};
  }

  if (typeof onReadable !== 'function') {
    throw buildError('model.find.streamerror', 'no valid onReadable function was provided');
  }
  if (typeof callback !== 'function') {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  options.return_query = true;
  var selectQuery = this.find(queryObject, options);

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  var self = this;

  this._execute_table_stream(selectQuery.query, selectQuery.params, queryOptions, function f1() {
    var reader = this;
    reader.readRow = function () {
      var row = reader.read();
      if (!row) return row;
      if (!options.raw) {
        var ModelConstructor = self._properties.get_constructor();
        var o = new ModelConstructor(row);
        o._modified = {};
        return o;
      }
      return row;
    };
    onReadable(reader);
  }, function (err) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    callback();
  });
};

BaseModel.find = function f(queryObject, options, callback) {
  var _this15 = this;

  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function' && !options.return_query) {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  // set raw true if select is used,
  // because casting to model instances may lead to problems
  if (options.select) options.raw = true;

  var queryParams = [];

  var query = void 0;
  try {
    var findQuery = this._create_find_query(queryObject, options);
    query = findQuery.query;
    queryParams = queryParams.concat(findQuery.params);
  } catch (e) {
    if (typeof callback === 'function') {
      callback(e);
      return {};
    }
    throw e;
  }

  if (options.return_query) {
    return { query: query, params: queryParams };
  }

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  this._execute_table_query(query, queryParams, queryOptions, function (err, results) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    if (!options.raw) {
      var ModelConstructor = _this15._properties.get_constructor();
      results = results.rows.map(function (res) {
        delete res.columns;
        var o = new ModelConstructor(res);
        o._modified = {};
        return o;
      });
      callback(null, results);
    } else {
      results = results.rows.map(function (res) {
        delete res.columns;
        return res;
      });
      callback(null, results);
    }
  });

  return {};
};

BaseModel.findOne = function f(queryObject, options, callback) {
  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function' && !options.return_query) {
    throw buildError('model.find.cberror');
  }

  queryObject.$limit = 1;

  return this.find(queryObject, options, function (err, results) {
    if (err) {
      callback(err);
      return;
    }
    if (results.length > 0) {
      callback(null, results[0]);
      return;
    }
    callback();
  });
};

BaseModel.update = function f(queryObject, updateValues, options, callback) {
  var _this16 = this;

  if (arguments.length === 3 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this._properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var queryParams = [];

  var updateClauseArray = [];

  var errorHappened = Object.keys(updateValues).some(function (key) {
    if (schema.fields[key] === undefined || schema.fields[key].virtual) return false;

    // check field value
    var fieldtype = schemer.get_field_type(schema, key);
    var fieldvalue = updateValues[key];

    if (fieldvalue === undefined) {
      fieldvalue = _this16._get_default_value(key);
      if (fieldvalue === undefined) {
        if (schema.key.indexOf(key) >= 0 || schema.key[0].indexOf(key) >= 0) {
          if (typeof callback === 'function') {
            callback(buildError('model.update.unsetkey', key));
            return true;
          }
          throw buildError('model.update.unsetkey', key);
        } else if (schema.fields[key].rule && schema.fields[key].rule.required) {
          if (typeof callback === 'function') {
            callback(buildError('model.update.unsetrequired', key));
            return true;
          }
          throw buildError('model.update.unsetrequired', key);
        } else return false;
      } else if (!schema.fields[key].rule || !schema.fields[key].rule.ignore_default) {
        // did set a default value, ignore default is not set
        if (_this16.validate(key, fieldvalue) !== true) {
          if (typeof callback === 'function') {
            callback(buildError('model.update.invaliddefaultvalue', fieldvalue, key, fieldtype));
            return true;
          }
          throw buildError('model.update.invaliddefaultvalue', fieldvalue, key, fieldtype);
        }
      }
    }

    if (fieldvalue === null || fieldvalue === cql.types.unset) {
      if (schema.key.indexOf(key) >= 0 || schema.key[0].indexOf(key) >= 0) {
        if (typeof callback === 'function') {
          callback(buildError('model.update.unsetkey', key));
          return true;
        }
        throw buildError('model.update.unsetkey', key);
      } else if (schema.fields[key].rule && schema.fields[key].rule.required) {
        if (typeof callback === 'function') {
          callback(buildError('model.update.unsetrequired', key));
          return true;
        }
        throw buildError('model.update.unsetrequired', key);
      }
    }

    try {
      var $add = false;
      var $append = false;
      var $prepend = false;
      var $replace = false;
      var $remove = false;
      if (_.isPlainObject(fieldvalue)) {
        if (fieldvalue.$add) {
          fieldvalue = fieldvalue.$add;
          $add = true;
        } else if (fieldvalue.$append) {
          fieldvalue = fieldvalue.$append;
          $append = true;
        } else if (fieldvalue.$prepend) {
          fieldvalue = fieldvalue.$prepend;
          $prepend = true;
        } else if (fieldvalue.$replace) {
          fieldvalue = fieldvalue.$replace;
          $replace = true;
        } else if (fieldvalue.$remove) {
          fieldvalue = fieldvalue.$remove;
          $remove = true;
        }
      }

      var dbVal = _this16._get_db_value_expression(key, fieldvalue);

      if (_.isPlainObject(dbVal) && dbVal.query_segment) {
        if (['map', 'list', 'set'].indexOf(fieldtype) > -1) {
          if ($add || $append) {
            dbVal.query_segment = util.format('"%s" + %s', key, dbVal.query_segment);
          } else if ($prepend) {
            if (fieldtype === 'list') {
              dbVal.query_segment = util.format('%s + "%s"', dbVal.query_segment, key);
            } else {
              throw buildError('model.update.invalidprependop', util.format('%s datatypes does not support $prepend, use $add instead', fieldtype));
            }
          } else if ($remove) {
            dbVal.query_segment = util.format('"%s" - %s', key, dbVal.query_segment);
            if (fieldtype === 'map') dbVal.parameter = Object.keys(dbVal.parameter);
          }
        }

        if ($replace) {
          if (fieldtype === 'map') {
            updateClauseArray.push(util.format('"%s"[?]=%s', key, dbVal.query_segment));
            var replaceKeys = Object.keys(dbVal.parameter);
            var replaceValues = _.values(dbVal.parameter);
            if (replaceKeys.length === 1) {
              queryParams.push(replaceKeys[0]);
              queryParams.push(replaceValues[0]);
            } else {
              throw buildError('model.update.invalidreplaceop', '$replace in map does not support more than one item');
            }
          } else if (fieldtype === 'list') {
            updateClauseArray.push(util.format('"%s"[?]=%s', key, dbVal.query_segment));
            if (dbVal.parameter.length === 2) {
              queryParams.push(dbVal.parameter[0]);
              queryParams.push(dbVal.parameter[1]);
            } else {
              throw buildError('model.update.invalidreplaceop', '$replace in list should have exactly 2 items, first one as the index and the second one as the value');
            }
          } else {
            throw buildError('model.update.invalidreplaceop', util.format('%s datatypes does not support $replace', fieldtype));
          }
        } else {
          updateClauseArray.push(util.format('"%s"=%s', key, dbVal.query_segment));
          queryParams.push(dbVal.parameter);
        }
      } else {
        updateClauseArray.push(util.format('"%s"=%s', key, dbVal));
      }
    } catch (e) {
      if (typeof callback === 'function') {
        callback(e);
        return true;
      }
      throw e;
    }
    return false;
  });

  if (errorHappened) return {};

  var query = 'UPDATE "%s"';
  var where = '';
  if (options.ttl) query += util.format(' USING TTL %s', options.ttl);
  query += ' SET %s %s';
  try {
    var whereClause = this._create_where_clause(queryObject);
    where = whereClause.query;
    queryParams = queryParams.concat(whereClause.params);
  } catch (e) {
    if (typeof callback === 'function') {
      callback(e);
      return {};
    }
    throw e;
  }
  query = util.format(query, this._properties.table_name, updateClauseArray.join(', '), where);

  if (options.conditions) {
    var ifClause = this._create_if_clause(options.conditions);
    if (ifClause.query) {
      query += util.format(' %s', ifClause.query);
      queryParams = queryParams.concat(ifClause.params);
    }
  } else if (options.if_exists) {
    query += ' IF EXISTS';
  }

  query += ';';

  // set dummy hook function if not present in schema
  if (typeof schema.before_update !== 'function') {
    schema.before_update = function f1(queryObj, updateVal, optionsObj, next) {
      next();
    };
  }

  if (typeof schema.after_update !== 'function') {
    schema.after_update = function f1(queryObj, updateVal, optionsObj, next) {
      next();
    };
  }

  function hookRunner(fn, errorCode) {
    return function (hookCallback) {
      fn(queryObject, updateValues, options, function (error) {
        if (error) {
          hookCallback(buildError(errorCode, error));
          return;
        }
        hookCallback();
      });
    };
  }

  if (options.return_query) {
    return {
      query: query,
      params: queryParams,
      before_hook: hookRunner(schema.before_update, 'model.update.before.error'),
      after_hook: hookRunner(schema.after_update, 'model.update.after.error')
    };
  }

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  schema.before_update(queryObject, updateValues, options, function (error) {
    if (error) {
      if (typeof callback === 'function') {
        callback(buildError('model.update.before.error', error));
        return;
      }
      throw buildError('model.update.before.error', error);
    }

    _this16._execute_table_query(query, queryParams, queryOptions, function (err, results) {
      if (typeof callback === 'function') {
        if (err) {
          callback(buildError('model.update.dberror', err));
          return;
        }
        schema.after_update(queryObject, updateValues, options, function (error1) {
          if (error1) {
            callback(buildError('model.update.after.error', error1));
            return;
          }
          callback(null, results);
        });
      } else if (err) {
        throw buildError('model.update.dberror', err);
      } else {
        schema.after_update(queryObject, updateValues, options, function (error1) {
          if (error1) {
            throw buildError('model.update.after.error', error1);
          }
        });
      }
    });
  });

  return {};
};

BaseModel.delete = function f(queryObject, options, callback) {
  var _this17 = this;

  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this._properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var queryParams = [];

  var query = 'DELETE FROM "%s" %s;';
  var where = '';
  try {
    var whereClause = this._create_where_clause(queryObject);
    where = whereClause.query;
    queryParams = queryParams.concat(whereClause.params);
  } catch (e) {
    if (typeof callback === 'function') {
      callback(e);
      return {};
    }
    throw e;
  }

  query = util.format(query, this._properties.table_name, where);

  // set dummy hook function if not present in schema
  if (typeof schema.before_delete !== 'function') {
    schema.before_delete = function f1(queryObj, optionsObj, next) {
      next();
    };
  }

  if (typeof schema.after_delete !== 'function') {
    schema.after_delete = function f1(queryObj, optionsObj, next) {
      next();
    };
  }

  if (options.return_query) {
    return {
      query: query,
      params: queryParams,
      before_hook: function before_hook(hookCallback) {
        schema.before_delete(queryObject, options, function (error) {
          if (error) {
            hookCallback(buildError('model.delete.before.error', error));
            return;
          }
          hookCallback();
        });
      },
      after_hook: function after_hook(hookCallback) {
        schema.after_delete(queryObject, options, function (error) {
          if (error) {
            hookCallback(buildError('model.delete.after.error', error));
            return;
          }
          hookCallback();
        });
      }
    };
  }

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  schema.before_delete(queryObject, options, function (error) {
    if (error) {
      if (typeof callback === 'function') {
        callback(buildError('model.delete.before.error', error));
        return;
      }
      throw buildError('model.delete.before.error', error);
    }

    _this17._execute_table_query(query, queryParams, queryOptions, function (err, results) {
      if (typeof callback === 'function') {
        if (err) {
          callback(buildError('model.delete.dberror', err));
          return;
        }
        schema.after_delete(queryObject, options, function (error1) {
          if (error1) {
            callback(buildError('model.delete.after.error', error1));
            return;
          }
          callback(null, results);
        });
      } else if (err) {
        throw buildError('model.delete.dberror', err);
      } else {
        schema.after_delete(queryObject, options, function (error1) {
          if (error1) {
            throw buildError('model.delete.after.error', error1);
          }
        });
      }
    });
  });

  return {};
};

BaseModel.truncate = function f(callback) {
  var properties = this._properties;
  var tableName = properties.table_name;

  var query = util.format('TRUNCATE TABLE "%s";', tableName);
  this._execute_definition_query(query, [], callback);
};

BaseModel.drop_mviews = function f(mviews, callback) {
  var _this18 = this;

  async.each(mviews, function (view, viewCallback) {
    var query = util.format('DROP MATERIALIZED VIEW IF EXISTS "%s";', view);
    _this18._execute_definition_query(query, [], viewCallback);
  }, function (err) {
    if (err) callback(err);else callback();
  });
};

BaseModel.drop_indexes = function f(indexes, callback) {
  var _this19 = this;

  async.each(indexes, function (index, indexCallback) {
    var query = util.format('DROP INDEX IF EXISTS "%s";', index);
    _this19._execute_definition_query(query, [], indexCallback);
  }, function (err) {
    if (err) callback(err);else callback();
  });
};

BaseModel.alter_table = function f(operation, fieldname, type, callback) {
  var properties = this._properties;
  var tableName = properties.table_name;

  if (operation === 'ALTER') type = util.format('TYPE %s', type);else if (operation === 'DROP') type = '';

  var query = util.format('ALTER TABLE "%s" %s "%s" %s;', tableName, operation, fieldname, type);
  this._execute_definition_query(query, [], callback);
};

BaseModel.drop_table = function f(callback) {
  var properties = this._properties;
  var tableName = properties.table_name;

  var query = util.format('DROP TABLE IF EXISTS "%s";', tableName);
  this._execute_definition_query(query, [], callback);
};

BaseModel.prototype._get_data_types = function f() {
  return cql.types;
};

BaseModel.prototype._get_default_value = function f(fieldname) {
  var properties = this.constructor._properties;
  var schema = properties.schema;

  if (_.isPlainObject(schema.fields[fieldname]) && schema.fields[fieldname].default !== undefined) {
    if (typeof schema.fields[fieldname].default === 'function') {
      return schema.fields[fieldname].default.call(this);
    }
    return schema.fields[fieldname].default;
  }
  return undefined;
};

BaseModel.prototype.validate = function f(propertyName, value) {
  value = value || this[propertyName];
  this._validators = this._validators || {};
  return this.constructor._validate(this._validators[propertyName] || [], value);
};

BaseModel.prototype.save = function fn(options, callback) {
  var _this20 = this;

  if (arguments.length === 1 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var identifiers = [];
  var values = [];
  var properties = this.constructor._properties;
  var schema = properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var queryParams = [];

  var errorHappened = Object.keys(schema.fields).some(function (f) {
    if (schema.fields[f].virtual) return false;

    // check field value
    var fieldtype = schemer.get_field_type(schema, f);
    var fieldvalue = _this20[f];

    if (fieldvalue === undefined) {
      fieldvalue = _this20._get_default_value(f);
      if (fieldvalue === undefined) {
        if (schema.key.indexOf(f) >= 0 || schema.key[0].indexOf(f) >= 0) {
          if (typeof callback === 'function') {
            callback(buildError('model.save.unsetkey', f));
            return true;
          }
          throw buildError('model.save.unsetkey', f);
        } else if (schema.fields[f].rule && schema.fields[f].rule.required) {
          if (typeof callback === 'function') {
            callback(buildError('model.save.unsetrequired', f));
            return true;
          }
          throw buildError('model.save.unsetrequired', f);
        } else return false;
      } else if (!schema.fields[f].rule || !schema.fields[f].rule.ignore_default) {
        // did set a default value, ignore default is not set
        if (_this20.validate(f, fieldvalue) !== true) {
          if (typeof callback === 'function') {
            callback(buildError('model.save.invaliddefaultvalue', fieldvalue, f, fieldtype));
            return true;
          }
          throw buildError('model.save.invaliddefaultvalue', fieldvalue, f, fieldtype);
        }
      }
    }

    if (fieldvalue === null || fieldvalue === cql.types.unset) {
      if (schema.key.indexOf(f) >= 0 || schema.key[0].indexOf(f) >= 0) {
        if (typeof callback === 'function') {
          callback(buildError('model.save.unsetkey', f));
          return true;
        }
        throw buildError('model.save.unsetkey', f);
      } else if (schema.fields[f].rule && schema.fields[f].rule.required) {
        if (typeof callback === 'function') {
          callback(buildError('model.save.unsetrequired', f));
          return true;
        }
        throw buildError('model.save.unsetrequired', f);
      }
    }

    identifiers.push(util.format('"%s"', f));

    try {
      var dbVal = _this20.constructor._get_db_value_expression(f, fieldvalue);
      if (_.isPlainObject(dbVal) && dbVal.query_segment) {
        values.push(dbVal.query_segment);
        queryParams.push(dbVal.parameter);
      } else {
        values.push(dbVal);
      }
    } catch (e) {
      if (typeof callback === 'function') {
        callback(e);
        return true;
      }
      throw e;
    }
    return false;
  });

  if (errorHappened) return {};

  var query = util.format('INSERT INTO "%s" ( %s ) VALUES ( %s )', properties.table_name, identifiers.join(' , '), values.join(' , '));

  if (options.if_not_exist) query += ' IF NOT EXISTS';
  if (options.ttl) query += util.format(' USING TTL %s', options.ttl);

  query += ';';

  // set dummy hook function if not present in schema
  if (typeof schema.before_save !== 'function') {
    schema.before_save = function f(instance, option, next) {
      next();
    };
  }

  if (typeof schema.after_save !== 'function') {
    schema.after_save = function f(instance, option, next) {
      next();
    };
  }

  if (options.return_query) {
    return {
      query: query,
      params: queryParams,
      before_hook: function before_hook(hookCallback) {
        schema.before_save(_this20, options, function (error) {
          if (error) {
            hookCallback(buildError('model.save.before.error', error));
            return;
          }
          hookCallback();
        });
      },
      after_hook: function after_hook(hookCallback) {
        schema.after_save(_this20, options, function (error) {
          if (error) {
            hookCallback(buildError('model.save.after.error', error));
            return;
          }
          hookCallback();
        });
      }
    };
  }

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  schema.before_save(this, options, function (error) {
    if (error) {
      if (typeof callback === 'function') {
        callback(buildError('model.save.before.error', error));
        return;
      }
      throw buildError('model.save.before.error', error);
    }

    _this20.constructor._execute_table_query(query, queryParams, queryOptions, function (err, result) {
      if (typeof callback === 'function') {
        if (err) {
          callback(buildError('model.save.dberror', err));
          return;
        }
        if (!options.if_not_exist || result.rows && result.rows[0] && result.rows[0]['[applied]']) {
          _this20._modified = {};
        }
        schema.after_save(_this20, options, function (error1) {
          if (error1) {
            callback(buildError('model.save.after.error', error1));
            return;
          }
          callback(null, result);
        });
      } else if (err) {
        throw buildError('model.save.dberror', err);
      } else {
        schema.after_save(_this20, options, function (error1) {
          if (error1) {
            throw buildError('model.save.after.error', error1);
          }
        });
      }
    });
  });

  return {};
};

/**
 * Implicit {return_query: true} in options.
 * No checks - just produces raw {query,params} record
 */
BaseModel.prototype.prepare_batch_insert_fast = function fn(options, callback) {
  if (arguments.length === 1 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var identifiers = [];
  var values = [];
  var properties = this.constructor._properties;
  var schema = properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var queryParams = [];

  var schemaFieldKeys = Object.keys(schema.fields);
  for (var i = 0, j = schemaFieldKeys.length; i < j; i++) {
    var f = schemaFieldKeys[i];

    if (schema.fields[f].virtual) continue;

    var fieldvalue = this[f];
    if (fieldvalue === undefined) {
      fieldvalue = this._get_default_value(f);
    }
    if (fieldvalue === undefined) {
      continue;
    }

    identifiers.push(util.format('"%s"', f));

    var dbVal = this.constructor._get_db_value_expression(f, fieldvalue);
    if (_.isPlainObject(dbVal) && dbVal.query_segment) {
      values.push(dbVal.query_segment);
      queryParams.push(dbVal.parameter);
    } else {
      values.push(dbVal);
    }
  }

  var query = util.format('INSERT INTO "%s" ( %s ) VALUES ( %s )', properties.table_name, identifiers.join(' , '), values.join(' , '));

  if (options.if_not_exist) query += ' IF NOT EXISTS';
  if (options.ttl) query += util.format(' USING TTL %s', options.ttl);

  query += ';';

  return {
    query: query,
    params: queryParams
  };
};

BaseModel.prototype.delete = function f(options, callback) {
  if (arguments.length === 1 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this.constructor._properties.schema;
  var deleteQuery = {};

  for (var i = 0; i < schema.key.length; i++) {
    var fieldKey = schema.key[i];
    if (fieldKey instanceof Array) {
      for (var j = 0; j < fieldKey.length; j++) {
        deleteQuery[fieldKey[j]] = this[fieldKey[j]];
      }
    } else {
      deleteQuery[fieldKey] = this[fieldKey];
    }
  }

  return this.constructor.delete(deleteQuery, options, callback);
};

BaseModel.prototype.toJSON = function toJSON() {
  var _this21 = this;

  var object = {};
  var schema = this.constructor._properties.schema;

  Object.keys(schema.fields).forEach(function (field) {
    object[field] = _this21[field];
  });

  return object;
};

BaseModel.prototype.isModified = function isModified(propName) {
  if (propName) {
    return Object.prototype.hasOwnProperty.call(this._modified, propName);
  }
  return Object.keys(this._modified).length !== 0;
};

module.exports = BaseModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9vcm0vYmFzZV9tb2RlbC5qcyJdLCJuYW1lcyI6WyJ0cnlSZXF1aXJlIiwicmVxdWlyZSIsImRzZURyaXZlciIsInV0aWwiLCJjcWwiLCJhc3luYyIsIl8iLCJkZWVwRGlmZiIsImRpZmYiLCJyZWFkbGluZVN5bmMiLCJvYmplY3RIYXNoIiwiZGVidWciLCJidWlsZEVycm9yIiwic2NoZW1lciIsIlRZUEVfTUFQIiwiY2hlY2tEQlRhYmxlTmFtZSIsIm9iaiIsInRlc3QiLCJCYXNlTW9kZWwiLCJmIiwiaW5zdGFuY2VWYWx1ZXMiLCJmaWVsZFZhbHVlcyIsImZpZWxkcyIsImNvbnN0cnVjdG9yIiwiX3Byb3BlcnRpZXMiLCJzY2hlbWEiLCJtZXRob2RzIiwibW9kZWwiLCJkZWZhdWx0U2V0dGVyIiwiZjEiLCJwcm9wTmFtZSIsIm5ld1ZhbHVlIiwiX21vZGlmaWVkIiwiZGVmYXVsdEdldHRlciIsIl92YWxpZGF0b3JzIiwiZmllbGRzS2V5cyIsIk9iamVjdCIsImtleXMiLCJpIiwibGVuIiwibGVuZ3RoIiwicHJvcGVydHlOYW1lIiwiZmllbGQiLCJfZ2V0X3ZhbGlkYXRvcnMiLCJzZXR0ZXIiLCJiaW5kIiwiZ2V0dGVyIiwidmlydHVhbCIsInNldCIsImdldCIsImRlc2NyaXB0b3IiLCJlbnVtZXJhYmxlIiwiZGVmaW5lUHJvcGVydHkiLCJtZXRob2ROYW1lcyIsIm1ldGhvZE5hbWUiLCJtZXRob2QiLCJuYW1lIiwiX3NldF9wcm9wZXJ0aWVzIiwicHJvcGVydGllcyIsInRhYmxlTmFtZSIsInRhYmxlX25hbWUiLCJxdWFsaWZpZWRUYWJsZU5hbWUiLCJmb3JtYXQiLCJrZXlzcGFjZSIsInF1YWxpZmllZF90YWJsZV9uYW1lIiwiX3ZhbGlkYXRlIiwidmFsaWRhdG9ycyIsInZhbHVlIiwiaXNQbGFpbk9iamVjdCIsIiRkYl9mdW5jdGlvbiIsInYiLCJ2YWxpZGF0b3IiLCJtZXNzYWdlIiwiX2dldF9nZW5lcmljX3ZhbGlkYXRvcl9tZXNzYWdlIiwiZmllbGR0eXBlIiwiX2Zvcm1hdF92YWxpZGF0b3JfcnVsZSIsInJ1bGUiLCJmaWVsZG5hbWUiLCJnZXRfZmllbGRfdHlwZSIsImUiLCJ0eXBlRmllbGRWYWxpZGF0b3IiLCJnZW5lcmljX3R5cGVfdmFsaWRhdG9yIiwicHVzaCIsIkFycmF5IiwiaXNBcnJheSIsImZvckVhY2giLCJmaWVsZHJ1bGUiLCJfYXNrX2NvbmZpcm1hdGlvbiIsInBlcm1pc3Npb24iLCJkaXNhYmxlVFRZQ29uZmlybWF0aW9uIiwicXVlc3Rpb24iLCJfZW5zdXJlX2Nvbm5lY3RlZCIsImNhbGxiYWNrIiwiY29ubmVjdCIsIl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkiLCJxdWVyeSIsInBhcmFtcyIsImVyciIsImNvbm4iLCJkZWZpbmVfY29ubmVjdGlvbiIsImV4ZWN1dGUiLCJwcmVwYXJlIiwiZmV0Y2hTaXplIiwiX2V4ZWN1dGVfYmF0Y2giLCJxdWVyaWVzIiwib3B0aW9ucyIsImJhdGNoIiwiZXhlY3V0ZV9iYXRjaCIsImFyZ3VtZW50cyIsImRlZmF1bHRzIiwiZGVmYXVsdHNEZWVwIiwiZ2V0X2NxbF9jbGllbnQiLCJfY3JlYXRlX3RhYmxlIiwibW9kZWxTY2hlbWEiLCJkcm9wVGFibGVPblNjaGVtYUNoYW5nZSIsIm1pZ3JhdGlvbiIsInByb2Nlc3MiLCJlbnYiLCJOT0RFX0VOViIsIl9nZXRfZGJfdGFibGVfc2NoZW1hIiwiZGJTY2hlbWEiLCJhZnRlckN1c3RvbUluZGV4IiwiZXJyMSIsIm1hdGVyaWFsaXplZF92aWV3cyIsImVhY2hTZXJpZXMiLCJ2aWV3TmFtZSIsIm5leHQiLCJtYXRWaWV3UXVlcnkiLCJfY3JlYXRlX21hdGVyaWFsaXplZF92aWV3X3F1ZXJ5IiwiZXJyMiIsInJlc3VsdCIsImFmdGVyREJJbmRleCIsImN1c3RvbV9pbmRleGVzIiwiaWR4IiwiX2NyZWF0ZV9jdXN0b21faW5kZXhfcXVlcnkiLCJjdXN0b21faW5kZXgiLCJjdXN0b21JbmRleFF1ZXJ5IiwiYWZ0ZXJEQkNyZWF0ZSIsImluZGV4ZXMiLCJfY3JlYXRlX2luZGV4X3F1ZXJ5Iiwibm9ybWFsaXplZE1vZGVsU2NoZW1hIiwibm9ybWFsaXplZERCU2NoZW1hIiwibm9ybWFsaXplX21vZGVsX3NjaGVtYSIsImlzRXF1YWwiLCJkcm9wUmVjcmVhdGVUYWJsZSIsInRvTG93ZXJDYXNlIiwibXZpZXdzIiwiZHJvcF9tdmlld3MiLCJkcm9wX3RhYmxlIiwiY3JlYXRlVGFibGVRdWVyeSIsIl9jcmVhdGVfdGFibGVfcXVlcnkiLCJhZnRlckRCQWx0ZXIiLCJhZGRlZEluZGV4ZXMiLCJkaWZmZXJlbmNlIiwicmVtb3ZlZEluZGV4ZXMiLCJyZW1vdmVkSW5kZXhOYW1lcyIsInJlbW92ZWRJbmRleCIsImluZGV4X25hbWVzIiwiYWRkZWRDdXN0b21JbmRleGVzIiwiZmlsdGVyIiwiZmluZCIsInJlbW92ZWRDdXN0b21JbmRleGVzIiwiYWRkZWRNYXRlcmlhbGl6ZWRWaWV3cyIsInJlbW92ZWRNYXRlcmlhbGl6ZWRWaWV3cyIsImRyb3BfaW5kZXhlcyIsImVycjMiLCJlcnI0IiwiZXJyNSIsImVycjYiLCJhbHRlckRCVGFibGUiLCJkaWZmZXJlbmNlcyIsImZpZWxkTmFtZSIsInBhdGgiLCJhbHRlckZpZWxkVHlwZSIsImFsdGVyX3RhYmxlIiwicmhzIiwiYWx0ZXJBZGRGaWVsZCIsInR5cGUiLCJ0eXBlRGVmIiwiYWx0ZXJSZW1vdmVGaWVsZCIsIm5leHRDYWxsYmFjayIsImRlcGVuZGVudEluZGV4ZXMiLCJwdWxsSW5kZXhlcyIsImRiSW5kZXgiLCJpbmRleFNwbGl0Iiwic3BsaXQiLCJpbmRleEZpZWxkTmFtZSIsInB1bGxBbGwiLCJwdWxsQ3VzdG9tSW5kZXhlcyIsIm9uIiwiZGVwZW5kZW50Vmlld3MiLCJkYlZpZXdOYW1lIiwic2VsZWN0IiwiaW5kZXhPZiIsImtleSIsImtpbmQiLCJsaHMiLCJFcnJvciIsImNsdXN0ZXJpbmdfb3JkZXIiLCJyb3dzIiwiZmllbGRUeXBlIiwiayIsInNlZ21lbnQiLCJzdGF0aWMiLCJwYXJ0aXRpb25LZXkiLCJjbHVzdGVyaW5nS2V5Iiwic2xpY2UiLCJjbHVzdGVyaW5nT3JkZXIiLCJjbHVzdGVyaW5nT3JkZXJRdWVyeSIsInRvU3RyaW5nIiwibWFwIiwiam9pbiIsInZpZXdTY2hlbWEiLCJ3aGVyZUNsYXVzZSIsImluZGV4TmFtZSIsImluZGV4RXhwcmVzc2lvbiIsInJlcGxhY2UiLCJjdXN0b21JbmRleCIsInVzaW5nIiwic2VsZiIsImV4ZWN1dGVfcXVlcnkiLCJyZXN1bHRDb2x1bW5zIiwidHlwZU1hcHMiLCJzdGF0aWNNYXBzIiwiciIsInJvdyIsImNvbHVtbl9uYW1lIiwiZXh0cmFjdF90eXBlIiwidHlwZU1hcERlZiIsImV4dHJhY3RfdHlwZURlZiIsInBvc2l0aW9uIiwicmVzdWx0SW5kZXhlcyIsImluZGV4X25hbWUiLCJ0YXJnZXQiLCJpbmRleE9wdGlvbnMiLCJjbGFzc19uYW1lIiwiY3VzdG9tSW5kZXhPYmplY3QiLCJyZXN1bHRWaWV3cyIsImJhc2VfdGFibGVfbmFtZSIsInZpZXdfbmFtZSIsInJlc3VsdE1hdFZpZXdzIiwiX2V4ZWN1dGVfdGFibGVfcXVlcnkiLCJkb0V4ZWN1dGVRdWVyeSIsImRvcXVlcnkiLCJkb2NhbGxiYWNrIiwiaXNfdGFibGVfcmVhZHkiLCJpbml0IiwiX2dldF9kYl92YWx1ZV9leHByZXNzaW9uIiwiZmllbGR2YWx1ZSIsInR5cGVzIiwidW5zZXQiLCJxdWVyeV9zZWdtZW50IiwicGFyYW1ldGVyIiwidmFsIiwiZGJWYWwiLCJ2YWxpZGF0aW9uTWVzc2FnZSIsImNvdW50ZXJRdWVyeVNlZ21lbnQiLCJNYXRoIiwiYWJzIiwiX3BhcnNlX3F1ZXJ5X29iamVjdCIsInF1ZXJ5T2JqZWN0IiwicXVlcnlSZWxhdGlvbnMiLCJxdWVyeVBhcmFtcyIsImluZGV4Iiwid2hlcmVPYmplY3QiLCJmayIsImZpZWxkUmVsYXRpb24iLCJjcWxPcGVyYXRvcnMiLCIkZXEiLCIkbmUiLCIkZ3QiLCIkbHQiLCIkZ3RlIiwiJGx0ZSIsIiRpbiIsIiRsaWtlIiwiJHRva2VuIiwiJGNvbnRhaW5zIiwiJGNvbnRhaW5zX2tleSIsInZhbGlkS2V5cyIsImZpZWxkUmVsYXRpb25LZXlzIiwicmVsS2V5cyIsInJrIiwiZmlyc3RLZXkiLCJmaXJzdFZhbHVlIiwib3AiLCJ3aGVyZVRlbXBsYXRlIiwidG9rZW5SZWxLZXlzIiwidG9rZW5SSyIsInRva2VuRmlyc3RLZXkiLCJ0b2tlbkZpcnN0VmFsdWUiLCJ0b2tlbktleXMiLCJ0b2tlbkluZGV4IiwidHJpbSIsImZpZWxkdHlwZTEiLCJmaWVsZHR5cGUyIiwiX2NyZWF0ZV93aGVyZV9jbGF1c2UiLCJwYXJzZWRPYmplY3QiLCJfY3JlYXRlX2lmX2NsYXVzZSIsImlmQ2xhdXNlIiwiX2NyZWF0ZV9maW5kX3F1ZXJ5Iiwib3JkZXJLZXlzIiwibGltaXQiLCJxdWVyeUl0ZW0iLCJvcmRlckl0ZW1LZXlzIiwiY3FsT3JkZXJEaXJlY3Rpb24iLCIkYXNjIiwiJGRlc2MiLCJvcmRlckZpZWxkcyIsImoiLCJzZWxlY3RBcnJheSIsInNlbGVjdGlvbiIsImZ1bmN0aW9uQ2xhdXNlIiwiZGlzdGluY3QiLCJtYXRlcmlhbGl6ZWRfdmlldyIsImFsbG93X2ZpbHRlcmluZyIsImdldF90YWJsZV9uYW1lIiwiX3JlYWR5IiwidW5kZWZpbmVkIiwic3luY0RlZmluaXRpb24iLCJhZnRlckNyZWF0ZSIsImNvZGUiLCJleGVjdXRlX2VhY2hSb3ciLCJvblJlYWRhYmxlIiwiZWFjaFJvdyIsIl9leGVjdXRlX3RhYmxlX2VhY2hSb3ciLCJjYiIsInJhdyIsInJldHVybl9xdWVyeSIsInNlbGVjdFF1ZXJ5IiwicXVlcnlPcHRpb25zIiwiY29uc2lzdGVuY3kiLCJhdXRvUGFnZSIsImhpbnRzIiwicGFnZVN0YXRlIiwicmV0cnkiLCJzZXJpYWxDb25zaXN0ZW5jeSIsIm4iLCJNb2RlbENvbnN0cnVjdG9yIiwiZ2V0X2NvbnN0cnVjdG9yIiwiZXhlY3V0ZV9zdHJlYW0iLCJzdHJlYW0iLCJfZXhlY3V0ZV90YWJsZV9zdHJlYW0iLCJyZWFkZXIiLCJyZWFkUm93IiwicmVhZCIsIm8iLCJmaW5kUXVlcnkiLCJjb25jYXQiLCJyZXN1bHRzIiwicmVzIiwiY29sdW1ucyIsImZpbmRPbmUiLCIkbGltaXQiLCJ1cGRhdGUiLCJ1cGRhdGVWYWx1ZXMiLCJ1cGRhdGVDbGF1c2VBcnJheSIsImVycm9ySGFwcGVuZWQiLCJzb21lIiwiX2dldF9kZWZhdWx0X3ZhbHVlIiwicmVxdWlyZWQiLCJpZ25vcmVfZGVmYXVsdCIsInZhbGlkYXRlIiwiJGFkZCIsIiRhcHBlbmQiLCIkcHJlcGVuZCIsIiRyZXBsYWNlIiwiJHJlbW92ZSIsInJlcGxhY2VLZXlzIiwicmVwbGFjZVZhbHVlcyIsInZhbHVlcyIsIndoZXJlIiwidHRsIiwiY29uZGl0aW9ucyIsImlmX2V4aXN0cyIsImJlZm9yZV91cGRhdGUiLCJxdWVyeU9iaiIsInVwZGF0ZVZhbCIsIm9wdGlvbnNPYmoiLCJhZnRlcl91cGRhdGUiLCJob29rUnVubmVyIiwiZm4iLCJlcnJvckNvZGUiLCJob29rQ2FsbGJhY2siLCJlcnJvciIsImJlZm9yZV9ob29rIiwiYWZ0ZXJfaG9vayIsImVycm9yMSIsImRlbGV0ZSIsImJlZm9yZV9kZWxldGUiLCJhZnRlcl9kZWxldGUiLCJ0cnVuY2F0ZSIsImVhY2giLCJ2aWV3Iiwidmlld0NhbGxiYWNrIiwiaW5kZXhDYWxsYmFjayIsIm9wZXJhdGlvbiIsInByb3RvdHlwZSIsIl9nZXRfZGF0YV90eXBlcyIsImRlZmF1bHQiLCJjYWxsIiwic2F2ZSIsImlkZW50aWZpZXJzIiwiaWZfbm90X2V4aXN0IiwiYmVmb3JlX3NhdmUiLCJpbnN0YW5jZSIsIm9wdGlvbiIsImFmdGVyX3NhdmUiLCJwcmVwYXJlX2JhdGNoX2luc2VydF9mYXN0Iiwic2NoZW1hRmllbGRLZXlzIiwiZGVsZXRlUXVlcnkiLCJmaWVsZEtleSIsInRvSlNPTiIsIm9iamVjdCIsImlzTW9kaWZpZWQiLCJoYXNPd25Qcm9wZXJ0eSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7O0FBQUEsSUFBTUEsYUFBYUMsUUFB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QVQsR0FBa0I7QUFBQTs7QUFDN0MsTUFBTUMsU0FBUyxFQUFmO0FBQ0EsTUFBTXBZLFNBQVMsS0FBS0YsV0FBTCxDQUFpQkMsV0FBakIsQ0FBNkJDLE1BQTVDOztBQUVBVyxTQUFPQyxJQUFQLENBQVlaLE9BQU9ILE1BQW5CLEVBQTJCK0QsT0FBM0IsQ0FBbUMsVUFBQzNDLEtBQUQsRUFBVztBQUM1Q21YLFdBQU9uWCxLQUFQLElBQWdCLFFBQUtBLEtBQUwsQ0FBaEI7QUFDRCxHQUZEOztBQUlBLFNBQU9tWCxNQUFQO0FBQ0QsQ0FURDs7QUFXQTNZLFVBQVUyWCxTQUFWLENBQW9CaUIsVUFBcEIsR0FBaUMsU0FBU0EsVUFBVCxDQUFvQmhZLFFBQXBCLEVBQThCO0FBQzdELE1BQUlBLFFBQUosRUFBYztBQUNaLFdBQU9NLE9BQU95VyxTQUFQLENBQWlCa0IsY0FBakIsQ0FBZ0NmLElBQWhDLENBQXFDLEtBQUtoWCxTQUExQyxFQUFxREYsUUFBckQsQ0FBUDtBQUNEO0FBQ0QsU0FBT00sT0FBT0MsSUFBUCxDQUFZLEtBQUtMLFNBQWpCLEVBQTRCUSxNQUE1QixLQUF1QyxDQUE5QztBQUNELENBTEQ7O0FBT0F3WCxPQUFPQyxPQUFQLEdBQWlCL1ksU0FBakIiLCJmaWxlIjoiYmFzZV9tb2RlbC5qcyIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHRyeVJlcXVpcmUgPSByZXF1aXJlKCd0cnktcmVxdWlyZScpO1xuXG5jb25zdCBkc2VEcml2ZXIgPSB0cnlSZXF1aXJlKCdkc2UtZHJpdmVyJyk7XG5cbmNvbnN0IHV0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG5jb25zdCBjcWwgPSBkc2VEcml2ZXIgfHwgcmVxdWlyZSgnY2Fzc2FuZHJhLWRyaXZlcicpO1xuY29uc3QgYXN5bmMgPSByZXF1aXJlKCdhc3luYycpO1xuY29uc3QgXyA9IHJlcXVpcmUoJ2xvZGFzaCcpO1xuY29uc3QgZGVlcERpZmYgPSByZXF1aXJlKCdkZWVwLWRpZmYnKS5kaWZmO1xuY29uc3QgcmVhZGxpbmVTeW5jID0gcmVxdWlyZSgncmVhZGxpbmUtc3luYycpO1xuY29uc3Qgb2JqZWN0SGFzaCA9IHJlcXVpcmUoJ29iamVjdC1oYXNoJyk7XG5jb25zdCBkZWJ1ZyA9IHJlcXVpcmUoJ2RlYnVnJykoJ2V4cHJlc3MtY2Fzc2FuZHJhJyk7XG5cbmNvbnN0IGJ1aWxkRXJyb3IgPSByZXF1aXJlKCcuL2Fwb2xsb19lcnJvci5qcycpO1xuY29uc3Qgc2NoZW1lciA9IHJlcXVpcmUoJy4vYXBvbGxvX3NjaGVtZXInKTtcblxuY29uc3QgVFlQRV9NQVAgPSByZXF1aXJlKCcuL2Nhc3NhbmRyYV90eXBlcycpO1xuXG5jb25zdCBjaGVja0RCVGFibGVOYW1lID0gKG9iaikgPT4gKCh0eXBlb2Ygb2JqID09PSAnc3RyaW5nJyAmJiAvXlthLXpBLVpdK1thLXpBLVowLTlfXSovLnRlc3Qob2JqKSkpO1xuXG5jb25zdCBCYXNlTW9kZWwgPSBmdW5jdGlvbiBmKGluc3RhbmNlVmFsdWVzKSB7XG4gIGluc3RhbmNlVmFsdWVzID0gaW5zdGFuY2VWYWx1ZXMgfHwge307XG4gIGNvbnN0IGZpZWxkVmFsdWVzID0ge307XG4gIGNvbnN0IGZpZWxkcyA9IHRoaXMuY29uc3RydWN0b3IuX3Byb3BlcnRpZXMuc2NoZW1hLmZpZWxkcztcbiAgY29uc3QgbWV0aG9kcyA9IHRoaXMuY29uc3RydWN0b3IuX3Byb3BlcnRpZXMuc2NoZW1hLm1ldGhvZHMgfHwge307XG4gIGNvbnN0IG1vZGVsID0gdGhpcztcblxuICBjb25zdCBkZWZhdWx0U2V0dGVyID0gZnVuY3Rpb24gZjEocHJvcE5hbWUsIG5ld1ZhbHVlKSB7XG4gICAgaWYgKHRoaXNbcHJvcE5hbWVdICE9PSBuZXdWYWx1ZSkge1xuICAgICAgbW9kZWwuX21vZGlmaWVkW3Byb3BOYW1lXSA9IHRydWU7XG4gICAgfVxuICAgIHRoaXNbcHJvcE5hbWVdID0gbmV3VmFsdWU7XG4gIH07XG5cbiAgY29uc3QgZGVmYXVsdEdldHRlciA9IGZ1bmN0aW9uIGYxKHByb3BOYW1lKSB7XG4gICAgcmV0dXJuIHRoaXNbcHJvcE5hbWVdO1xuICB9O1xuXG4gIHRoaXMuX21vZGlmaWVkID0ge307XG4gIHRoaXMuX3ZhbGlkYXRvcnMgPSB7fTtcblxuICBmb3IgKGxldCBmaWVsZHNLZXlzID0gT2JqZWN0LmtleXMoZmllbGRzKSwgaSA9IDAsIGxlbiA9IGZpZWxkc0tleXMubGVuZ3RoOyBpIDwgbGVuOyBpKyspIHtcbiAgICBjb25zdCBwcm9wZXJ0eU5hbWUgPSBmaWVsZHNLZXlzW2ldO1xuICAgIGNvbnN0IGZpZWxkID0gZmllbGRzW2ZpZWxkc0tleXNbaV1dO1xuXG4gICAgdGhpcy5fdmFsaWRhdG9yc1twcm9wZXJ0eU5hbWVdID0gdGhpcy5jb25zdHJ1Y3Rvci5fZ2V0X3ZhbGlkYXRvcnMocHJvcGVydHlOYW1lKTtcblxuICAgIGxldCBzZXR0ZXIgPSBkZWZhdWx0U2V0dGVyLmJpbmQoZmllbGRWYWx1ZXMsIHByb3BlcnR5TmFtZSk7XG4gICAgbGV0IGdldHRlciA9IGRlZmF1bHRHZXR0ZXIuYmluZChmaWVsZFZhbHVlcywgcHJvcGVydHlOYW1lKTtcblxuICAgIGlmIChmaWVsZC52aXJ0dWFsICYmIHR5cGVvZiBmaWVsZC52aXJ0dWFsLnNldCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgc2V0dGVyID0gZmllbGQudmlydHVhbC5zZXQuYmluZChmaWVsZFZhbHVlcyk7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkLnZpcnR1YWwgJiYgdHlwZW9mIGZpZWxkLnZpcnR1YWwuZ2V0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBnZXR0ZXIgPSBmaWVsZC52aXJ0dWFsLmdldC5iaW5kKGZpZWxkVmFsdWVzKTtcbiAgICB9XG5cbiAgICBjb25zdCBkZXNjcmlwdG9yID0ge1xuICAgICAgZW51bWVyYWJsZTogdHJ1ZSxcbiAgICAgIHNldDogc2V0dGVyLFxuICAgICAgZ2V0OiBnZXR0ZXIsXG4gICAgfTtcblxuICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh0aGlzLCBwcm9wZXJ0eU5hbWUsIGRlc2NyaXB0b3IpO1xuICAgIGlmICghZmllbGQudmlydHVhbCkge1xuICAgICAgdGhpc1twcm9wZXJ0eU5hbWVdID0gaW5zdGFuY2VWYWx1ZXNbcHJvcGVydHlOYW1lXTtcbiAgICB9XG4gIH1cblxuICBmb3IgKGxldCBtZXRob2ROYW1lcyA9IE9iamVjdC5rZXlzKG1ldGhvZHMpLCBpID0gMCwgbGVuID0gbWV0aG9kTmFtZXMubGVuZ3RoOyBpIDwgbGVuOyBpKyspIHtcbiAgICBjb25zdCBtZXRob2ROYW1lID0gbWV0aG9kTmFtZXNbaV07XG4gICAgY29uc3QgbWV0aG9kID0gbWV0aG9kc1ttZXRob2ROYW1lXTtcbiAgICB0aGlzW21ldGhvZE5hbWVdID0gbWV0aG9kO1xuICB9XG59O1xuXG5CYXNlTW9kZWwuX3Byb3BlcnRpZXMgPSB7XG4gIG5hbWU6IG51bGwsXG4gIHNjaGVtYTogbnVsbCxcbn07XG5cbkJhc2VNb2RlbC5fc2V0X3Byb3BlcnRpZXMgPSBmdW5jdGlvbiBmKHByb3BlcnRpZXMpIHtcbiAgY29uc3Qgc2NoZW1hID0gcHJvcGVydGllcy5zY2hlbWE7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHNjaGVtYS50YWJsZV9uYW1lIHx8IHByb3BlcnRpZXMubmFtZTtcblxuICBpZiAoIWNoZWNrREJUYWJsZU5hbWUodGFibGVOYW1lKSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmludmFsaWRuYW1lJywgdGFibGVOYW1lKSk7XG4gIH1cblxuICBjb25zdCBxdWFsaWZpZWRUYWJsZU5hbWUgPSB1dGlsLmZvcm1hdCgnXCIlc1wiLlwiJXNcIicsIHByb3BlcnRpZXMua2V5c3BhY2UsIHRhYmxlTmFtZSk7XG5cbiAgdGhpcy5fcHJvcGVydGllcyA9IHByb3BlcnRpZXM7XG4gIHRoaXMuX3Byb3BlcnRpZXMudGFibGVfbmFtZSA9IHRhYmxlTmFtZTtcbiAgdGhpcy5fcHJvcGVydGllcy5xdWFsaWZpZWRfdGFibGVfbmFtZSA9IHF1YWxpZmllZFRhYmxlTmFtZTtcbn07XG5cbkJhc2VNb2RlbC5fdmFsaWRhdGUgPSBmdW5jdGlvbiBmKHZhbGlkYXRvcnMsIHZhbHVlKSB7XG4gIGlmICh2YWx1ZSA9PSBudWxsIHx8IChfLmlzUGxhaW5PYmplY3QodmFsdWUpICYmIHZhbHVlLiRkYl9mdW5jdGlvbikpIHJldHVybiB0cnVlO1xuXG4gIGZvciAobGV0IHYgPSAwOyB2IDwgdmFsaWRhdG9ycy5sZW5ndGg7IHYrKykge1xuICAgIGlmICh0eXBlb2YgdmFsaWRhdG9yc1t2XS52YWxpZGF0b3IgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGlmICghdmFsaWRhdG9yc1t2XS52YWxpZGF0b3IodmFsdWUpKSB7XG4gICAgICAgIHJldHVybiB2YWxpZGF0b3JzW3ZdLm1lc3NhZ2U7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIHJldHVybiB0cnVlO1xufTtcblxuQmFzZU1vZGVsLl9nZXRfZ2VuZXJpY192YWxpZGF0b3JfbWVzc2FnZSA9IGZ1bmN0aW9uIGYodmFsdWUsIHByb3BOYW1lLCBmaWVsZHR5cGUpIHtcbiAgcmV0dXJuIHV0aWwuZm9ybWF0KCdJbnZhbGlkIFZhbHVlOiBcIiVzXCIgZm9yIEZpZWxkOiAlcyAoVHlwZTogJXMpJywgdmFsdWUsIHByb3BOYW1lLCBmaWVsZHR5cGUpO1xufTtcblxuQmFzZU1vZGVsLl9mb3JtYXRfdmFsaWRhdG9yX3J1bGUgPSBmdW5jdGlvbiBmKHJ1bGUpIHtcbiAgaWYgKHR5cGVvZiBydWxlLnZhbGlkYXRvciAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHJ1bGUnLCAnUnVsZSB2YWxpZGF0b3IgbXVzdCBiZSBhIHZhbGlkIGZ1bmN0aW9uJykpO1xuICB9XG4gIGlmICghcnVsZS5tZXNzYWdlKSB7XG4gICAgcnVsZS5tZXNzYWdlID0gdGhpcy5fZ2V0X2dlbmVyaWNfdmFsaWRhdG9yX21lc3NhZ2U7XG4gIH0gZWxzZSBpZiAodHlwZW9mIHJ1bGUubWVzc2FnZSA9PT0gJ3N0cmluZycpIHtcbiAgICBydWxlLm1lc3NhZ2UgPSBmdW5jdGlvbiBmMShtZXNzYWdlKSB7XG4gICAgICByZXR1cm4gdXRpbC5mb3JtYXQobWVzc2FnZSk7XG4gICAgfS5iaW5kKG51bGwsIHJ1bGUubWVzc2FnZSk7XG4gIH0gZWxzZSBpZiAodHlwZW9mIHJ1bGUubWVzc2FnZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHJ1bGUnLCAnSW52YWxpZCB2YWxpZGF0b3IgbWVzc2FnZSwgbXVzdCBiZSBzdHJpbmcgb3IgYSBmdW5jdGlvbicpKTtcbiAgfVxuXG4gIHJldHVybiBydWxlO1xufTtcblxuQmFzZU1vZGVsLl9nZXRfdmFsaWRhdG9ycyA9IGZ1bmN0aW9uIGYoZmllbGRuYW1lKSB7XG4gIGxldCBmaWVsZHR5cGU7XG4gIHRyeSB7XG4gICAgZmllbGR0eXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZSh0aGlzLl9wcm9wZXJ0aWVzLnNjaGVtYSwgZmllbGRuYW1lKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHNjaGVtYScsIGUubWVzc2FnZSkpO1xuICB9XG5cbiAgY29uc3QgdmFsaWRhdG9ycyA9IFtdO1xuICBjb25zdCB0eXBlRmllbGRWYWxpZGF0b3IgPSBUWVBFX01BUC5nZW5lcmljX3R5cGVfdmFsaWRhdG9yKGZpZWxkdHlwZSk7XG5cbiAgaWYgKHR5cGVGaWVsZFZhbGlkYXRvcikgdmFsaWRhdG9ycy5wdXNoKHR5cGVGaWVsZFZhbGlkYXRvcik7XG5cbiAgY29uc3QgZmllbGQgPSB0aGlzLl9wcm9wZXJ0aWVzLnNjaGVtYS5maWVsZHNbZmllbGRuYW1lXTtcbiAgaWYgKHR5cGVvZiBmaWVsZC5ydWxlICE9PSAndW5kZWZpbmVkJykge1xuICAgIGlmICh0eXBlb2YgZmllbGQucnVsZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgZmllbGQucnVsZSA9IHtcbiAgICAgICAgdmFsaWRhdG9yOiBmaWVsZC5ydWxlLFxuICAgICAgICBtZXNzYWdlOiB0aGlzLl9nZXRfZ2VuZXJpY192YWxpZGF0b3JfbWVzc2FnZSxcbiAgICAgIH07XG4gICAgICB2YWxpZGF0b3JzLnB1c2goZmllbGQucnVsZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KGZpZWxkLnJ1bGUpKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHJ1bGUnLCAnVmFsaWRhdGlvbiBydWxlIG11c3QgYmUgYSBmdW5jdGlvbiBvciBhbiBvYmplY3QnKSk7XG4gICAgICB9XG4gICAgICBpZiAoZmllbGQucnVsZS52YWxpZGF0b3IpIHtcbiAgICAgICAgdmFsaWRhdG9ycy5wdXNoKHRoaXMuX2Zvcm1hdF92YWxpZGF0b3JfcnVsZShmaWVsZC5ydWxlKSk7XG4gICAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoZmllbGQucnVsZS52YWxpZGF0b3JzKSkge1xuICAgICAgICBmaWVsZC5ydWxlLnZhbGlkYXRvcnMuZm9yRWFjaCgoZmllbGRydWxlKSA9PiB7XG4gICAgICAgICAgdmFsaWRhdG9ycy5wdXNoKHRoaXMuX2Zvcm1hdF92YWxpZGF0b3JfcnVsZShmaWVsZHJ1bGUpKTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHZhbGlkYXRvcnM7XG59O1xuXG5CYXNlTW9kZWwuX2Fza19jb25maXJtYXRpb24gPSBmdW5jdGlvbiBmKG1lc3NhZ2UpIHtcbiAgbGV0IHBlcm1pc3Npb24gPSAneSc7XG4gIGlmICghdGhpcy5fcHJvcGVydGllcy5kaXNhYmxlVFRZQ29uZmlybWF0aW9uKSB7XG4gICAgcGVybWlzc2lvbiA9IHJlYWRsaW5lU3luYy5xdWVzdGlvbihtZXNzYWdlKTtcbiAgfVxuICByZXR1cm4gcGVybWlzc2lvbjtcbn07XG5cbkJhc2VNb2RlbC5fZW5zdXJlX2Nvbm5lY3RlZCA9IGZ1bmN0aW9uIGYoY2FsbGJhY2spIHtcbiAgaWYgKCF0aGlzLl9wcm9wZXJ0aWVzLmNxbCkge1xuICAgIHRoaXMuX3Byb3BlcnRpZXMuY29ubmVjdChjYWxsYmFjayk7XG4gIH0gZWxzZSB7XG4gICAgY2FsbGJhY2soKTtcbiAgfVxufTtcblxuQmFzZU1vZGVsLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkgPSBmdW5jdGlvbiBmKHF1ZXJ5LCBwYXJhbXMsIGNhbGxiYWNrKSB7XG4gIHRoaXMuX2Vuc3VyZV9jb25uZWN0ZWQoKGVycikgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGRlYnVnKCdleGVjdXRpbmcgZGVmaW5pdGlvbiBxdWVyeTogJXMgd2l0aCBwYXJhbXM6ICVqJywgcXVlcnksIHBhcmFtcyk7XG4gICAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gICAgY29uc3QgY29ubiA9IHByb3BlcnRpZXMuZGVmaW5lX2Nvbm5lY3Rpb247XG4gICAgY29ubi5leGVjdXRlKHF1ZXJ5LCBwYXJhbXMsIHsgcHJlcGFyZTogZmFsc2UsIGZldGNoU2l6ZTogMCB9LCBjYWxsYmFjayk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLl9leGVjdXRlX2JhdGNoID0gZnVuY3Rpb24gZihxdWVyaWVzLCBvcHRpb25zLCBjYWxsYmFjaykge1xuICB0aGlzLl9lbnN1cmVfY29ubmVjdGVkKChlcnIpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBkZWJ1ZygnZXhlY3V0aW5nIGJhdGNoIHF1ZXJpZXM6ICVqJywgcXVlcmllcyk7XG4gICAgdGhpcy5fcHJvcGVydGllcy5jcWwuYmF0Y2gocXVlcmllcywgb3B0aW9ucywgY2FsbGJhY2spO1xuICB9KTtcbn07XG5cbkJhc2VNb2RlbC5leGVjdXRlX2JhdGNoID0gZnVuY3Rpb24gZihxdWVyaWVzLCBvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMikge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgdGhpcy5fZXhlY3V0ZV9iYXRjaChxdWVyaWVzLCBvcHRpb25zLCBjYWxsYmFjayk7XG59O1xuXG5CYXNlTW9kZWwuZ2V0X2NxbF9jbGllbnQgPSBmdW5jdGlvbiBmKGNhbGxiYWNrKSB7XG4gIHRoaXMuX2Vuc3VyZV9jb25uZWN0ZWQoKGVycikgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNhbGxiYWNrKG51bGwsIHRoaXMuX3Byb3BlcnRpZXMuY3FsKTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuX2NyZWF0ZV90YWJsZSA9IGZ1bmN0aW9uIGYoY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcbiAgY29uc3QgbW9kZWxTY2hlbWEgPSBwcm9wZXJ0aWVzLnNjaGVtYTtcbiAgY29uc3QgZHJvcFRhYmxlT25TY2hlbWFDaGFuZ2UgPSBwcm9wZXJ0aWVzLmRyb3BUYWJsZU9uU2NoZW1hQ2hhbmdlO1xuICBsZXQgbWlncmF0aW9uID0gcHJvcGVydGllcy5taWdyYXRpb247XG5cbiAgLy8gYmFja3dhcmRzIGNvbXBhdGlibGUgY2hhbmdlLCBkcm9wVGFibGVPblNjaGVtYUNoYW5nZSB3aWxsIHdvcmsgbGlrZSBtaWdyYXRpb246ICdkcm9wJ1xuICBpZiAoIW1pZ3JhdGlvbikge1xuICAgIGlmIChkcm9wVGFibGVPblNjaGVtYUNoYW5nZSkgbWlncmF0aW9uID0gJ2Ryb3AnO1xuICAgIGVsc2UgbWlncmF0aW9uID0gJ3NhZmUnO1xuICB9XG4gIC8vIGFsd2F5cyBzYWZlIG1pZ3JhdGUgaWYgTk9ERV9FTlY9PT0ncHJvZHVjdGlvbidcbiAgaWYgKHByb2Nlc3MuZW52Lk5PREVfRU5WID09PSAncHJvZHVjdGlvbicpIG1pZ3JhdGlvbiA9ICdzYWZlJztcblxuICAvLyBjaGVjayBmb3IgZXhpc3RlbmNlIG9mIHRhYmxlIG9uIERCIGFuZCBpZiBpdCBtYXRjaGVzIHRoaXMgbW9kZWwncyBzY2hlbWFcbiAgdGhpcy5fZ2V0X2RiX3RhYmxlX3NjaGVtYSgoZXJyLCBkYlNjaGVtYSkgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgYWZ0ZXJDdXN0b21JbmRleCA9IChlcnIxKSA9PiB7XG4gICAgICBpZiAoZXJyMSkge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiaW5kZXhjcmVhdGUnLCBlcnIxKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIG1hdGVyaWFsaXplZCB2aWV3IGNyZWF0aW9uXG4gICAgICBpZiAobW9kZWxTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKSB7XG4gICAgICAgIGFzeW5jLmVhY2hTZXJpZXMoT2JqZWN0LmtleXMobW9kZWxTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKSwgKHZpZXdOYW1lLCBuZXh0KSA9PiB7XG4gICAgICAgICAgY29uc3QgbWF0Vmlld1F1ZXJ5ID0gdGhpcy5fY3JlYXRlX21hdGVyaWFsaXplZF92aWV3X3F1ZXJ5KFxuICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgdmlld05hbWUsXG4gICAgICAgICAgICBtb2RlbFNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbdmlld05hbWVdLFxuICAgICAgICAgICk7XG4gICAgICAgICAgdGhpcy5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KG1hdFZpZXdRdWVyeSwgW10sIChlcnIyLCByZXN1bHQpID0+IHtcbiAgICAgICAgICAgIGlmIChlcnIyKSBuZXh0KGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24ubWF0dmlld2NyZWF0ZScsIGVycjIpKTtcbiAgICAgICAgICAgIGVsc2UgbmV4dChudWxsLCByZXN1bHQpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9LCBjYWxsYmFjayk7XG4gICAgICB9IGVsc2UgY2FsbGJhY2soKTtcbiAgICB9O1xuXG4gICAgY29uc3QgYWZ0ZXJEQkluZGV4ID0gKGVycjEpID0+IHtcbiAgICAgIGlmIChlcnIxKSB7XG4gICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJpbmRleGNyZWF0ZScsIGVycjEpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgLy8gY3VzdG9tIGluZGV4IGNyZWF0aW9uXG4gICAgICBpZiAobW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4ZXMpIHtcbiAgICAgICAgYXN5bmMuZWFjaFNlcmllcyhtb2RlbFNjaGVtYS5jdXN0b21faW5kZXhlcywgKGlkeCwgbmV4dCkgPT4ge1xuICAgICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeSh0aGlzLl9jcmVhdGVfY3VzdG9tX2luZGV4X3F1ZXJ5KHRhYmxlTmFtZSwgaWR4KSwgW10sIChlcnIyLCByZXN1bHQpID0+IHtcbiAgICAgICAgICAgIGlmIChlcnIyKSBuZXh0KGVycjIpO1xuICAgICAgICAgICAgZWxzZSBuZXh0KG51bGwsIHJlc3VsdCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0sIGFmdGVyQ3VzdG9tSW5kZXgpO1xuICAgICAgfSBlbHNlIGlmIChtb2RlbFNjaGVtYS5jdXN0b21faW5kZXgpIHtcbiAgICAgICAgY29uc3QgY3VzdG9tSW5kZXhRdWVyeSA9IHRoaXMuX2NyZWF0ZV9jdXN0b21faW5kZXhfcXVlcnkodGFibGVOYW1lLCBtb2RlbFNjaGVtYS5jdXN0b21faW5kZXgpO1xuICAgICAgICB0aGlzLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkoY3VzdG9tSW5kZXhRdWVyeSwgW10sIChlcnIyLCByZXN1bHQpID0+IHtcbiAgICAgICAgICBpZiAoZXJyMikgYWZ0ZXJDdXN0b21JbmRleChlcnIyKTtcbiAgICAgICAgICBlbHNlIGFmdGVyQ3VzdG9tSW5kZXgobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgYWZ0ZXJDdXN0b21JbmRleCgpO1xuICAgIH07XG5cbiAgICBjb25zdCBhZnRlckRCQ3JlYXRlID0gKGVycjEpID0+IHtcbiAgICAgIGlmIChlcnIxKSB7XG4gICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJjcmVhdGUnLCBlcnIxKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIGluZGV4IGNyZWF0aW9uXG4gICAgICBpZiAobW9kZWxTY2hlbWEuaW5kZXhlcyBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgICAgIGFzeW5jLmVhY2hTZXJpZXMobW9kZWxTY2hlbWEuaW5kZXhlcywgKGlkeCwgbmV4dCkgPT4ge1xuICAgICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeSh0aGlzLl9jcmVhdGVfaW5kZXhfcXVlcnkodGFibGVOYW1lLCBpZHgpLCBbXSwgKGVycjIsIHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgaWYgKGVycjIpIG5leHQoZXJyMik7XG4gICAgICAgICAgICBlbHNlIG5leHQobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSwgYWZ0ZXJEQkluZGV4KTtcbiAgICAgIH0gZWxzZSBhZnRlckRCSW5kZXgoKTtcbiAgICB9O1xuXG4gICAgaWYgKGRiU2NoZW1hKSB7XG4gICAgICBsZXQgbm9ybWFsaXplZE1vZGVsU2NoZW1hO1xuICAgICAgbGV0IG5vcm1hbGl6ZWREQlNjaGVtYTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgbm9ybWFsaXplZE1vZGVsU2NoZW1hID0gc2NoZW1lci5ub3JtYWxpemVfbW9kZWxfc2NoZW1hKG1vZGVsU2NoZW1hKTtcbiAgICAgICAgbm9ybWFsaXplZERCU2NoZW1hID0gc2NoZW1lci5ub3JtYWxpemVfbW9kZWxfc2NoZW1hKGRiU2NoZW1hKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnZhbGlkYXRvci5pbnZhbGlkc2NoZW1hJywgZS5tZXNzYWdlKSk7XG4gICAgICB9XG5cbiAgICAgIGlmIChfLmlzRXF1YWwobm9ybWFsaXplZE1vZGVsU2NoZW1hLCBub3JtYWxpemVkREJTY2hlbWEpKSB7XG4gICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBkcm9wUmVjcmVhdGVUYWJsZSA9ICgpID0+IHtcbiAgICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gdGhpcy5fYXNrX2NvbmZpcm1hdGlvbihcbiAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAnTWlncmF0aW9uOiBtb2RlbCBzY2hlbWEgY2hhbmdlZCBmb3IgdGFibGUgXCIlc1wiLCBkcm9wIHRhYmxlICYgcmVjcmVhdGU/IChkYXRhIHdpbGwgYmUgbG9zdCEpICh5L24pOiAnLFxuICAgICAgICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgICAgICApLFxuICAgICAgICAgICk7XG4gICAgICAgICAgaWYgKHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKSA9PT0gJ3knKSB7XG4gICAgICAgICAgICBpZiAobm9ybWFsaXplZERCU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cykge1xuICAgICAgICAgICAgICBjb25zdCBtdmlld3MgPSBPYmplY3Qua2V5cyhub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKTtcblxuICAgICAgICAgICAgICB0aGlzLmRyb3BfbXZpZXdzKG12aWV3cywgKGVycjEpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZXJyMSkge1xuICAgICAgICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5tYXR2aWV3ZHJvcCcsIGVycjEpKTtcbiAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aGlzLmRyb3BfdGFibGUoKGVycjIpID0+IHtcbiAgICAgICAgICAgICAgICAgIGlmIChlcnIyKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJkcm9wJywgZXJyMikpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICBjb25zdCBjcmVhdGVUYWJsZVF1ZXJ5ID0gdGhpcy5fY3JlYXRlX3RhYmxlX3F1ZXJ5KHRhYmxlTmFtZSwgbW9kZWxTY2hlbWEpO1xuICAgICAgICAgICAgICAgICAgdGhpcy5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KGNyZWF0ZVRhYmxlUXVlcnksIFtdLCBhZnRlckRCQ3JlYXRlKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB0aGlzLmRyb3BfdGFibGUoKGVycjEpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZXJyMSkge1xuICAgICAgICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYmRyb3AnLCBlcnIxKSk7XG4gICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IGNyZWF0ZVRhYmxlUXVlcnkgPSB0aGlzLl9jcmVhdGVfdGFibGVfcXVlcnkodGFibGVOYW1lLCBtb2RlbFNjaGVtYSk7XG4gICAgICAgICAgICAgICAgdGhpcy5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KGNyZWF0ZVRhYmxlUXVlcnksIFtdLCBhZnRlckRCQ3JlYXRlKTtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uc2NoZW1hbWlzbWF0Y2gnLCB0YWJsZU5hbWUpKTtcbiAgICAgICAgICB9XG4gICAgICAgIH07XG5cbiAgICAgICAgY29uc3QgYWZ0ZXJEQkFsdGVyID0gKGVycjEpID0+IHtcbiAgICAgICAgICBpZiAoZXJyMSkge1xuICAgICAgICAgICAgaWYgKGVycjEubWVzc2FnZSAhPT0gJ2JyZWFrJykgY2FsbGJhY2soZXJyMSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIGl0IHNob3VsZCBjcmVhdGUvZHJvcCBpbmRleGVzL2N1c3RvbV9pbmRleGVzL21hdGVyaWFsaXplZF92aWV3cyB0aGF0IGFyZSBhZGRlZC9yZW1vdmVkIGluIG1vZGVsIHNjaGVtYVxuICAgICAgICAgIC8vIHJlbW92ZSBjb21tb24gaW5kZXhlcy9jdXN0b21faW5kZXhlcy9tYXRlcmlhbGl6ZWRfdmlld3MgZnJvbSBub3JtYWxpemVkTW9kZWxTY2hlbWEgYW5kIG5vcm1hbGl6ZWREQlNjaGVtYVxuICAgICAgICAgIC8vIHRoZW4gZHJvcCBhbGwgcmVtYWluaW5nIGluZGV4ZXMvY3VzdG9tX2luZGV4ZXMvbWF0ZXJpYWxpemVkX3ZpZXdzIGZyb20gbm9ybWFsaXplZERCU2NoZW1hXG4gICAgICAgICAgLy8gYW5kIGFkZCBhbGwgcmVtYWluaW5nIGluZGV4ZXMvY3VzdG9tX2luZGV4ZXMvbWF0ZXJpYWxpemVkX3ZpZXdzIGZyb20gbm9ybWFsaXplZE1vZGVsU2NoZW1hXG4gICAgICAgICAgY29uc3QgYWRkZWRJbmRleGVzID0gXy5kaWZmZXJlbmNlKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5pbmRleGVzLCBub3JtYWxpemVkREJTY2hlbWEuaW5kZXhlcyk7XG4gICAgICAgICAgY29uc3QgcmVtb3ZlZEluZGV4ZXMgPSBfLmRpZmZlcmVuY2Uobm9ybWFsaXplZERCU2NoZW1hLmluZGV4ZXMsIG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5pbmRleGVzKTtcbiAgICAgICAgICBjb25zdCByZW1vdmVkSW5kZXhOYW1lcyA9IFtdO1xuICAgICAgICAgIHJlbW92ZWRJbmRleGVzLmZvckVhY2goKHJlbW92ZWRJbmRleCkgPT4ge1xuICAgICAgICAgICAgcmVtb3ZlZEluZGV4TmFtZXMucHVzaChkYlNjaGVtYS5pbmRleF9uYW1lc1tyZW1vdmVkSW5kZXhdKTtcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIGNvbnN0IGFkZGVkQ3VzdG9tSW5kZXhlcyA9IF8uZmlsdGVyKFxuICAgICAgICAgICAgbm9ybWFsaXplZE1vZGVsU2NoZW1hLmN1c3RvbV9pbmRleGVzLFxuICAgICAgICAgICAgKG9iaikgPT4gKCFfLmZpbmQobm9ybWFsaXplZERCU2NoZW1hLmN1c3RvbV9pbmRleGVzLCBvYmopKSxcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnN0IHJlbW92ZWRDdXN0b21JbmRleGVzID0gXy5maWx0ZXIoXG4gICAgICAgICAgICBub3JtYWxpemVkREJTY2hlbWEuY3VzdG9tX2luZGV4ZXMsXG4gICAgICAgICAgICAob2JqKSA9PiAoIV8uZmluZChub3JtYWxpemVkTW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4ZXMsIG9iaikpLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmVtb3ZlZEN1c3RvbUluZGV4ZXMuZm9yRWFjaCgocmVtb3ZlZEluZGV4KSA9PiB7XG4gICAgICAgICAgICByZW1vdmVkSW5kZXhOYW1lcy5wdXNoKGRiU2NoZW1hLmluZGV4X25hbWVzW29iamVjdEhhc2gocmVtb3ZlZEluZGV4KV0pO1xuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgY29uc3QgYWRkZWRNYXRlcmlhbGl6ZWRWaWV3cyA9IF8uZmlsdGVyKFxuICAgICAgICAgICAgT2JqZWN0LmtleXMobm9ybWFsaXplZE1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cyksXG4gICAgICAgICAgICAodmlld05hbWUpID0+XG4gICAgICAgICAgICAgICghXy5maW5kKG5vcm1hbGl6ZWREQlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MsIG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbdmlld05hbWVdKSksXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb25zdCByZW1vdmVkTWF0ZXJpYWxpemVkVmlld3MgPSBfLmZpbHRlcihcbiAgICAgICAgICAgIE9iamVjdC5rZXlzKG5vcm1hbGl6ZWREQlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MpLFxuICAgICAgICAgICAgKHZpZXdOYW1lKSA9PlxuICAgICAgICAgICAgICAoIV8uZmluZChub3JtYWxpemVkTW9kZWxTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzLCBub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3ZpZXdOYW1lXSkpLFxuICAgICAgICAgICk7XG5cbiAgICAgICAgICAvLyByZW1vdmUgYWx0ZXJlZCBtYXRlcmlhbGl6ZWQgdmlld3NcbiAgICAgICAgICBpZiAocmVtb3ZlZE1hdGVyaWFsaXplZFZpZXdzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGNvbnN0IHBlcm1pc3Npb24gPSB0aGlzLl9hc2tfY29uZmlybWF0aW9uKFxuICAgICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAnTWlncmF0aW9uOiBtb2RlbCBzY2hlbWEgZm9yIHRhYmxlIFwiJXNcIiBoYXMgcmVtb3ZlZCBtYXRlcmlhbGl6ZWRfdmlld3M6ICVqLCBkcm9wIHRoZW0/ICh5L24pOiAnLFxuICAgICAgICAgICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgICAgICAgICByZW1vdmVkTWF0ZXJpYWxpemVkVmlld3MsXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKSAhPT0gJ3knKSB7XG4gICAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uc2NoZW1hbWlzbWF0Y2gnLCB0YWJsZU5hbWUpKTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAocmVtb3ZlZEluZGV4TmFtZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgY29uc3QgcGVybWlzc2lvbiA9IHRoaXMuX2Fza19jb25maXJtYXRpb24oXG4gICAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICdNaWdyYXRpb246IG1vZGVsIHNjaGVtYSBmb3IgdGFibGUgXCIlc1wiIGhhcyByZW1vdmVkIGluZGV4ZXM6ICVqLCBkcm9wIHRoZW0/ICh5L24pOiAnLFxuICAgICAgICAgICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgICAgICAgICByZW1vdmVkSW5kZXhOYW1lcyxcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAocGVybWlzc2lvbi50b0xvd2VyQ2FzZSgpICE9PSAneScpIHtcbiAgICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5zY2hlbWFtaXNtYXRjaCcsIHRhYmxlTmFtZSkpO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgdGhpcy5kcm9wX212aWV3cyhyZW1vdmVkTWF0ZXJpYWxpemVkVmlld3MsIChlcnIyKSA9PiB7XG4gICAgICAgICAgICBpZiAoZXJyMikge1xuICAgICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLm1hdHZpZXdkcm9wJywgZXJyMikpO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIHJlbW92ZSBhbHRlcmVkIGluZGV4ZXMgYnkgaW5kZXggbmFtZVxuICAgICAgICAgICAgdGhpcy5kcm9wX2luZGV4ZXMocmVtb3ZlZEluZGV4TmFtZXMsIChlcnIzKSA9PiB7XG4gICAgICAgICAgICAgIGlmIChlcnIzKSB7XG4gICAgICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYmluZGV4ZHJvcCcsIGVycjMpKTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAvLyBhZGQgYWx0ZXJlZCBpbmRleGVzXG4gICAgICAgICAgICAgIGFzeW5jLmVhY2hTZXJpZXMoYWRkZWRJbmRleGVzLCAoaWR4LCBuZXh0KSA9PiB7XG4gICAgICAgICAgICAgICAgdGhpcy5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KHRoaXMuX2NyZWF0ZV9pbmRleF9xdWVyeSh0YWJsZU5hbWUsIGlkeCksIFtdLCAoZXJyNCwgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgICAgICAgICBpZiAoZXJyNCkgbmV4dChlcnI0KTtcbiAgICAgICAgICAgICAgICAgIGVsc2UgbmV4dChudWxsLCByZXN1bHQpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICB9LCAoZXJyNCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChlcnI0KSB7XG4gICAgICAgICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiaW5kZXhjcmVhdGUnLCBlcnI0KSk7XG4gICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy8gYWRkIGFsdGVyZWQgY3VzdG9tIGluZGV4ZXNcbiAgICAgICAgICAgICAgICBhc3luYy5lYWNoU2VyaWVzKGFkZGVkQ3VzdG9tSW5kZXhlcywgKGlkeCwgbmV4dCkgPT4ge1xuICAgICAgICAgICAgICAgICAgY29uc3QgY3VzdG9tSW5kZXhRdWVyeSA9IHRoaXMuX2NyZWF0ZV9jdXN0b21faW5kZXhfcXVlcnkodGFibGVOYW1lLCBpZHgpO1xuICAgICAgICAgICAgICAgICAgdGhpcy5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KGN1c3RvbUluZGV4UXVlcnksIFtdLCAoZXJyNSwgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChlcnI1KSBuZXh0KGVycjUpO1xuICAgICAgICAgICAgICAgICAgICBlbHNlIG5leHQobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0sIChlcnI1KSA9PiB7XG4gICAgICAgICAgICAgICAgICBpZiAoZXJyNSkge1xuICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiaW5kZXhjcmVhdGUnLCBlcnI1KSk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgLy8gYWRkIGFsdGVyZWQgbWF0ZXJpYWxpemVkX3ZpZXdzXG4gICAgICAgICAgICAgICAgICBhc3luYy5lYWNoU2VyaWVzKGFkZGVkTWF0ZXJpYWxpemVkVmlld3MsICh2aWV3TmFtZSwgbmV4dCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXRWaWV3UXVlcnkgPSB0aGlzLl9jcmVhdGVfbWF0ZXJpYWxpemVkX3ZpZXdfcXVlcnkoXG4gICAgICAgICAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgIHZpZXdOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgIG1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1t2aWV3TmFtZV0sXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShtYXRWaWV3UXVlcnksIFtdLCAoZXJyNiwgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgaWYgKGVycjYpIG5leHQoYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5tYXR2aWV3Y3JlYXRlJywgZXJyNikpO1xuICAgICAgICAgICAgICAgICAgICAgIGVsc2UgbmV4dChudWxsLCByZXN1bHQpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgIH0sIGNhbGxiYWNrKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfTtcblxuICAgICAgICBjb25zdCBhbHRlckRCVGFibGUgPSAoKSA9PiB7XG4gICAgICAgICAgY29uc3QgZGlmZmVyZW5jZXMgPSBkZWVwRGlmZihub3JtYWxpemVkREJTY2hlbWEuZmllbGRzLCBub3JtYWxpemVkTW9kZWxTY2hlbWEuZmllbGRzKTtcbiAgICAgICAgICBhc3luYy5lYWNoU2VyaWVzKGRpZmZlcmVuY2VzLCAoZGlmZiwgbmV4dCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgZmllbGROYW1lID0gZGlmZi5wYXRoWzBdO1xuICAgICAgICAgICAgY29uc3QgYWx0ZXJGaWVsZFR5cGUgPSAoKSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IHBlcm1pc3Npb24gPSB0aGlzLl9hc2tfY29uZmlybWF0aW9uKFxuICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgJ01pZ3JhdGlvbjogbW9kZWwgc2NoZW1hIGZvciB0YWJsZSBcIiVzXCIgaGFzIG5ldyB0eXBlIGZvciBmaWVsZCBcIiVzXCIsICcgK1xuICAgICAgICAgICAgICAgICAgJ2FsdGVyIHRhYmxlIHRvIHVwZGF0ZSBjb2x1bW4gdHlwZT8gKHkvbik6ICcsXG4gICAgICAgICAgICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgaWYgKHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKSA9PT0gJ3knKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5hbHRlcl90YWJsZSgnQUxURVInLCBmaWVsZE5hbWUsIGRpZmYucmhzLCAoZXJyMSwgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgICAgICAgICBpZiAoZXJyMSkgbmV4dChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiYWx0ZXInLCBlcnIxKSk7XG4gICAgICAgICAgICAgICAgICBlbHNlIG5leHQobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBuZXh0KGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uc2NoZW1hbWlzbWF0Y2gnLCB0YWJsZU5hbWUpKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgY29uc3QgYWx0ZXJBZGRGaWVsZCA9ICgpID0+IHtcbiAgICAgICAgICAgICAgbGV0IHR5cGUgPSAnJztcbiAgICAgICAgICAgICAgaWYgKGRpZmYucGF0aC5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRpZmYucGF0aFsxXSA9PT0gJ3R5cGUnKSB7XG4gICAgICAgICAgICAgICAgICB0eXBlID0gZGlmZi5yaHM7XG4gICAgICAgICAgICAgICAgICBpZiAobm9ybWFsaXplZE1vZGVsU2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGVEZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZSArPSBub3JtYWxpemVkTW9kZWxTY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZURlZjtcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgdHlwZSA9IG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlO1xuICAgICAgICAgICAgICAgICAgdHlwZSArPSBkaWZmLnJocztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IGRpZmYucmhzLnR5cGU7XG4gICAgICAgICAgICAgICAgaWYgKGRpZmYucmhzLnR5cGVEZWYpIHR5cGUgKz0gZGlmZi5yaHMudHlwZURlZjtcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIHRoaXMuYWx0ZXJfdGFibGUoJ0FERCcsIGZpZWxkTmFtZSwgdHlwZSwgKGVycjEsIHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChlcnIxKSBuZXh0KGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJhbHRlcicsIGVycjEpKTtcbiAgICAgICAgICAgICAgICBlbHNlIG5leHQobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICBjb25zdCBhbHRlclJlbW92ZUZpZWxkID0gKG5leHRDYWxsYmFjaykgPT4ge1xuICAgICAgICAgICAgICAvLyByZW1vdmUgZGVwZW5kZW50IGluZGV4ZXMvY3VzdG9tX2luZGV4ZXMvbWF0ZXJpYWxpemVkX3ZpZXdzLFxuICAgICAgICAgICAgICAvLyB1cGRhdGUgdGhlbSBpbiBub3JtYWxpemVkREJTY2hlbWEsIHRoZW4gYWx0ZXJcbiAgICAgICAgICAgICAgY29uc3QgZGVwZW5kZW50SW5kZXhlcyA9IFtdO1xuICAgICAgICAgICAgICBjb25zdCBwdWxsSW5kZXhlcyA9IFtdO1xuICAgICAgICAgICAgICBub3JtYWxpemVkREJTY2hlbWEuaW5kZXhlcy5mb3JFYWNoKChkYkluZGV4KSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgaW5kZXhTcGxpdCA9IGRiSW5kZXguc3BsaXQoL1soKV0vZyk7XG4gICAgICAgICAgICAgICAgbGV0IGluZGV4RmllbGROYW1lID0gJyc7XG4gICAgICAgICAgICAgICAgaWYgKGluZGV4U3BsaXQubGVuZ3RoID4gMSkgaW5kZXhGaWVsZE5hbWUgPSBpbmRleFNwbGl0WzFdO1xuICAgICAgICAgICAgICAgIGVsc2UgaW5kZXhGaWVsZE5hbWUgPSBpbmRleFNwbGl0WzBdO1xuICAgICAgICAgICAgICAgIGlmIChpbmRleEZpZWxkTmFtZSA9PT0gZmllbGROYW1lKSB7XG4gICAgICAgICAgICAgICAgICBkZXBlbmRlbnRJbmRleGVzLnB1c2goZGJTY2hlbWEuaW5kZXhfbmFtZXNbZGJJbmRleF0pO1xuICAgICAgICAgICAgICAgICAgcHVsbEluZGV4ZXMucHVzaChkYkluZGV4KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICBfLnB1bGxBbGwobm9ybWFsaXplZERCU2NoZW1hLmluZGV4ZXMsIHB1bGxJbmRleGVzKTtcblxuICAgICAgICAgICAgICBjb25zdCBwdWxsQ3VzdG9tSW5kZXhlcyA9IFtdO1xuICAgICAgICAgICAgICBub3JtYWxpemVkREJTY2hlbWEuY3VzdG9tX2luZGV4ZXMuZm9yRWFjaCgoZGJJbmRleCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChkYkluZGV4Lm9uID09PSBmaWVsZE5hbWUpIHtcbiAgICAgICAgICAgICAgICAgIGRlcGVuZGVudEluZGV4ZXMucHVzaChkYlNjaGVtYS5pbmRleF9uYW1lc1tvYmplY3RIYXNoKGRiSW5kZXgpXSk7XG4gICAgICAgICAgICAgICAgICBwdWxsQ3VzdG9tSW5kZXhlcy5wdXNoKGRiSW5kZXgpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIF8ucHVsbEFsbChub3JtYWxpemVkREJTY2hlbWEuY3VzdG9tX2luZGV4ZXMsIHB1bGxDdXN0b21JbmRleGVzKTtcblxuICAgICAgICAgICAgICBjb25zdCBkZXBlbmRlbnRWaWV3cyA9IFtdO1xuICAgICAgICAgICAgICBPYmplY3Qua2V5cyhub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKS5mb3JFYWNoKChkYlZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKG5vcm1hbGl6ZWREQlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3NbZGJWaWV3TmFtZV0uc2VsZWN0LmluZGV4T2YoZmllbGROYW1lKSA+IC0xKSB7XG4gICAgICAgICAgICAgICAgICBkZXBlbmRlbnRWaWV3cy5wdXNoKGRiVmlld05hbWUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAobm9ybWFsaXplZERCU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tkYlZpZXdOYW1lXS5zZWxlY3RbMF0gPT09ICcqJykge1xuICAgICAgICAgICAgICAgICAgZGVwZW5kZW50Vmlld3MucHVzaChkYlZpZXdOYW1lKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKG5vcm1hbGl6ZWREQlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3NbZGJWaWV3TmFtZV0ua2V5LmluZGV4T2YoZmllbGROYW1lKSA+IC0xKSB7XG4gICAgICAgICAgICAgICAgICBkZXBlbmRlbnRWaWV3cy5wdXNoKGRiVmlld05hbWUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAobm9ybWFsaXplZERCU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tkYlZpZXdOYW1lXS5rZXlbMF0gaW5zdGFuY2VvZiBBcnJheVxuICAgICAgICAgICAgICAgICAgJiYgbm9ybWFsaXplZERCU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tkYlZpZXdOYW1lXS5rZXlbMF0uaW5kZXhPZihmaWVsZE5hbWUpID4gLTEpIHtcbiAgICAgICAgICAgICAgICAgIGRlcGVuZGVudFZpZXdzLnB1c2goZGJWaWV3TmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgZGVwZW5kZW50Vmlld3MuZm9yRWFjaCgodmlld05hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBkZWxldGUgbm9ybWFsaXplZERCU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1t2aWV3TmFtZV07XG4gICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgIHRoaXMuZHJvcF9tdmlld3MoZGVwZW5kZW50Vmlld3MsIChlcnIxKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGVycjEpIHtcbiAgICAgICAgICAgICAgICAgIG5leHRDYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLm1hdHZpZXdkcm9wJywgZXJyMSkpO1xuICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRoaXMuZHJvcF9pbmRleGVzKGRlcGVuZGVudEluZGV4ZXMsIChlcnIyKSA9PiB7XG4gICAgICAgICAgICAgICAgICBpZiAoZXJyMikge1xuICAgICAgICAgICAgICAgICAgICBuZXh0Q2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYmluZGV4ZHJvcCcsIGVycjIpKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICB0aGlzLmFsdGVyX3RhYmxlKCdEUk9QJywgZmllbGROYW1lLCAnJywgKGVycjMsIHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZXJyMykgbmV4dENhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJhbHRlcicsIGVycjMpKTtcbiAgICAgICAgICAgICAgICAgICAgZWxzZSBuZXh0Q2FsbGJhY2sobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIGlmIChkaWZmLmtpbmQgPT09ICdOJykge1xuICAgICAgICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gdGhpcy5fYXNrX2NvbmZpcm1hdGlvbihcbiAgICAgICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAgICdNaWdyYXRpb246IG1vZGVsIHNjaGVtYSBmb3IgdGFibGUgXCIlc1wiIGhhcyBhZGRlZCBmaWVsZCBcIiVzXCIsIGFsdGVyIHRhYmxlIHRvIGFkZCBjb2x1bW4/ICh5L24pOiAnLFxuICAgICAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIGlmIChwZXJtaXNzaW9uLnRvTG93ZXJDYXNlKCkgPT09ICd5Jykge1xuICAgICAgICAgICAgICAgIGFsdGVyQWRkRmllbGQoKTtcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBuZXh0KGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uc2NoZW1hbWlzbWF0Y2gnLCB0YWJsZU5hbWUpKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChkaWZmLmtpbmQgPT09ICdEJykge1xuICAgICAgICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gdGhpcy5fYXNrX2NvbmZpcm1hdGlvbihcbiAgICAgICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAgICdNaWdyYXRpb246IG1vZGVsIHNjaGVtYSBmb3IgdGFibGUgXCIlc1wiIGhhcyByZW1vdmVkIGZpZWxkIFwiJXNcIiwgYWx0ZXIgdGFibGUgdG8gZHJvcCBjb2x1bW4/ICcgK1xuICAgICAgICAgICAgICAgICAgJyhjb2x1bW4gZGF0YSB3aWxsIGJlIGxvc3QgJiBkZXBlbmRlbnQgaW5kZXhlcy92aWV3cyB3aWxsIGJlIHJlY3JlYXRlZCEpICh5L24pOiAnLFxuICAgICAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIGlmIChwZXJtaXNzaW9uLnRvTG93ZXJDYXNlKCkgPT09ICd5Jykge1xuICAgICAgICAgICAgICAgIGFsdGVyUmVtb3ZlRmllbGQobmV4dCk7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgbmV4dChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lKSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZGlmZi5raW5kID09PSAnRScpIHtcbiAgICAgICAgICAgICAgLy8gY2hlY2sgaWYgdGhlIGFsdGVyIGZpZWxkIHR5cGUgaXMgcG9zc2libGUsIG90aGVyd2lzZSB0cnkgRCBhbmQgdGhlbiBOXG4gICAgICAgICAgICAgIGlmIChkaWZmLnBhdGhbMV0gPT09ICd0eXBlJykge1xuICAgICAgICAgICAgICAgIGlmIChkaWZmLmxocyA9PT0gJ2ludCcgJiYgZGlmZi5yaHMgPT09ICd2YXJpbnQnKSB7XG4gICAgICAgICAgICAgICAgICAvLyBhbHRlciBmaWVsZCB0eXBlIHBvc3NpYmxlXG4gICAgICAgICAgICAgICAgICBhbHRlckZpZWxkVHlwZSgpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAobm9ybWFsaXplZERCU2NoZW1hLmtleS5pbmRleE9mKGZpZWxkTmFtZSkgPiAwKSB7IC8vIGNoZWNrIGlmIGZpZWxkIHBhcnQgb2YgY2x1c3RlcmluZyBrZXlcbiAgICAgICAgICAgICAgICAgIC8vIGFsdGVyIGZpZWxkIHR5cGUgaW1wb3NzaWJsZVxuICAgICAgICAgICAgICAgICAgY29uc3QgcGVybWlzc2lvbiA9IHRoaXMuX2Fza19jb25maXJtYXRpb24oXG4gICAgICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgICAgICdNaWdyYXRpb246IG1vZGVsIHNjaGVtYSBmb3IgdGFibGUgXCIlc1wiIGhhcyBuZXcgaW5jb21wYXRpYmxlIHR5cGUgZm9yIHByaW1hcnkga2V5IGZpZWxkIFwiJXNcIiwgJyArXG4gICAgICAgICAgICAgICAgICAgICAgJ3Byb2NlZWQgdG8gcmVjcmVhdGUgdGFibGU/ICh5L24pOiAnLFxuICAgICAgICAgICAgICAgICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgaWYgKHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKSA9PT0gJ3knKSB7XG4gICAgICAgICAgICAgICAgICAgIGRyb3BSZWNyZWF0ZVRhYmxlKCk7XG4gICAgICAgICAgICAgICAgICAgIG5leHQobmV3IEVycm9yKCdicmVhaycpKTtcbiAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIG5leHQoYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5zY2hlbWFtaXNtYXRjaCcsIHRhYmxlTmFtZSkpO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoWyd0ZXh0JywgJ2FzY2lpJywgJ2JpZ2ludCcsICdib29sZWFuJywgJ2RlY2ltYWwnLFxuICAgICAgICAgICAgICAgICAgJ2RvdWJsZScsICdmbG9hdCcsICdpbmV0JywgJ2ludCcsICd0aW1lc3RhbXAnLCAndGltZXV1aWQnLFxuICAgICAgICAgICAgICAgICAgJ3V1aWQnLCAndmFyY2hhcicsICd2YXJpbnQnXS5pbmRleE9mKGRpZmYubGhzKSA+IC0xICYmIGRpZmYucmhzID09PSAnYmxvYicpIHtcbiAgICAgICAgICAgICAgICAgIC8vIGFsdGVyIGZpZWxkIHR5cGUgcG9zc2libGVcbiAgICAgICAgICAgICAgICAgIGFsdGVyRmllbGRUeXBlKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChkaWZmLmxocyA9PT0gJ3RpbWV1dWlkJyAmJiBkaWZmLnJocyA9PT0gJ3V1aWQnKSB7XG4gICAgICAgICAgICAgICAgICAvLyBhbHRlciBmaWVsZCB0eXBlIHBvc3NpYmxlXG4gICAgICAgICAgICAgICAgICBhbHRlckZpZWxkVHlwZSgpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAobm9ybWFsaXplZERCU2NoZW1hLmtleVswXS5pbmRleE9mKGZpZWxkTmFtZSkgPiAtMSkgeyAvLyBjaGVjayBpZiBmaWVsZCBwYXJ0IG9mIHBhcnRpdGlvbiBrZXlcbiAgICAgICAgICAgICAgICAgIC8vIGFsdGVyIGZpZWxkIHR5cGUgaW1wb3NzaWJsZVxuICAgICAgICAgICAgICAgICAgY29uc3QgcGVybWlzc2lvbiA9IHRoaXMuX2Fza19jb25maXJtYXRpb24oXG4gICAgICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgICAgICdNaWdyYXRpb246IG1vZGVsIHNjaGVtYSBmb3IgdGFibGUgXCIlc1wiIGhhcyBuZXcgaW5jb21wYXRpYmxlIHR5cGUgZm9yIHByaW1hcnkga2V5IGZpZWxkIFwiJXNcIiwgJyArXG4gICAgICAgICAgICAgICAgICAgICAgJ3Byb2NlZWQgdG8gcmVjcmVhdGUgdGFibGU/ICh5L24pOiAnLFxuICAgICAgICAgICAgICAgICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgaWYgKHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKSA9PT0gJ3knKSB7XG4gICAgICAgICAgICAgICAgICAgIGRyb3BSZWNyZWF0ZVRhYmxlKCk7XG4gICAgICAgICAgICAgICAgICAgIG5leHQobmV3IEVycm9yKCdicmVhaycpKTtcbiAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIG5leHQoYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5zY2hlbWFtaXNtYXRjaCcsIHRhYmxlTmFtZSkpO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAvLyBhbHRlciB0eXBlIGltcG9zc2libGVcbiAgICAgICAgICAgICAgICAgIGNvbnN0IHBlcm1pc3Npb24gPSB0aGlzLl9hc2tfY29uZmlybWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAgICAgICAnTWlncmF0aW9uOiBtb2RlbCBzY2hlbWEgZm9yIHRhYmxlIFwiJXNcIiBoYXMgbmV3IGluY29tcGF0aWJsZSB0eXBlIGZvciBmaWVsZCBcIiVzXCIsIGRyb3AgY29sdW1uICcgK1xuICAgICAgICAgICAgICAgICAgICAgICdhbmQgcmVjcmVhdGU/IChjb2x1bW4gZGF0YSB3aWxsIGJlIGxvc3QgJiBkZXBlbmRlbnQgaW5kZXhlcy92aWV3cyB3aWxsIGJlIHJlY3JlYXRlZCEpICh5L24pOiAnLFxuICAgICAgICAgICAgICAgICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgaWYgKHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKSA9PT0gJ3knKSB7XG4gICAgICAgICAgICAgICAgICAgIGFsdGVyUmVtb3ZlRmllbGQoKGVycjEpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICBpZiAoZXJyMSkgbmV4dChlcnIxKTtcbiAgICAgICAgICAgICAgICAgICAgICBlbHNlIGFsdGVyQWRkRmllbGQoKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBuZXh0KGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uc2NoZW1hbWlzbWF0Y2gnLCB0YWJsZU5hbWUpKTtcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gYWx0ZXIgdHlwZSBpbXBvc3NpYmxlXG4gICAgICAgICAgICAgICAgY29uc3QgcGVybWlzc2lvbiA9IHRoaXMuX2Fza19jb25maXJtYXRpb24oXG4gICAgICAgICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAgICAgJ01pZ3JhdGlvbjogbW9kZWwgc2NoZW1hIGZvciB0YWJsZSBcIiVzXCIgaGFzIG5ldyBpbmNvbXBhdGlibGUgdHlwZSBmb3IgZmllbGQgXCIlc1wiLCBkcm9wIGNvbHVtbiAnICtcbiAgICAgICAgICAgICAgICAgICAgJ2FuZCByZWNyZWF0ZT8gKGNvbHVtbiBkYXRhIHdpbGwgYmUgbG9zdCAmIGRlcGVuZGVudCBpbmRleGVzL3ZpZXdzIHdpbGwgYmUgcmVjcmVhdGVkISkgKHkvbik6ICcsXG4gICAgICAgICAgICAgICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIGlmIChwZXJtaXNzaW9uLnRvTG93ZXJDYXNlKCkgPT09ICd5Jykge1xuICAgICAgICAgICAgICAgICAgYWx0ZXJSZW1vdmVGaWVsZCgoZXJyMSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZXJyMSkgbmV4dChlcnIxKTtcbiAgICAgICAgICAgICAgICAgICAgZWxzZSBhbHRlckFkZEZpZWxkKCk7XG4gICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgbmV4dChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBuZXh0KCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSwgYWZ0ZXJEQkFsdGVyKTtcbiAgICAgICAgfTtcblxuICAgICAgICBpZiAobWlncmF0aW9uID09PSAnYWx0ZXInKSB7XG4gICAgICAgICAgLy8gY2hlY2sgaWYgdGFibGUgY2FuIGJlIGFsdGVyZWQgdG8gbWF0Y2ggc2NoZW1hXG4gICAgICAgICAgaWYgKF8uaXNFcXVhbChub3JtYWxpemVkTW9kZWxTY2hlbWEua2V5LCBub3JtYWxpemVkREJTY2hlbWEua2V5KSAmJlxuICAgICAgICAgICAgXy5pc0VxdWFsKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5jbHVzdGVyaW5nX29yZGVyLCBub3JtYWxpemVkREJTY2hlbWEuY2x1c3RlcmluZ19vcmRlcikpIHtcbiAgICAgICAgICAgIGFsdGVyREJUYWJsZSgpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBkcm9wUmVjcmVhdGVUYWJsZSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChtaWdyYXRpb24gPT09ICdkcm9wJykge1xuICAgICAgICAgIGRyb3BSZWNyZWF0ZVRhYmxlKCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5zY2hlbWFtaXNtYXRjaCcsIHRhYmxlTmFtZSkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIGlmIG5vdCBleGlzdGluZywgaXQncyBjcmVhdGVkXG4gICAgICBjb25zdCBjcmVhdGVUYWJsZVF1ZXJ5ID0gdGhpcy5fY3JlYXRlX3RhYmxlX3F1ZXJ5KHRhYmxlTmFtZSwgbW9kZWxTY2hlbWEpO1xuICAgICAgdGhpcy5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KGNyZWF0ZVRhYmxlUXVlcnksIFtdLCBhZnRlckRCQ3JlYXRlKTtcbiAgICB9XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLl9jcmVhdGVfdGFibGVfcXVlcnkgPSBmdW5jdGlvbiBmKHRhYmxlTmFtZSwgc2NoZW1hKSB7XG4gIGNvbnN0IHJvd3MgPSBbXTtcbiAgbGV0IGZpZWxkVHlwZTtcbiAgT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuZm9yRWFjaCgoaykgPT4ge1xuICAgIGlmIChzY2hlbWEuZmllbGRzW2tdLnZpcnR1YWwpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbGV0IHNlZ21lbnQgPSAnJztcbiAgICBmaWVsZFR5cGUgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHNjaGVtYSwgayk7XG4gICAgaWYgKHNjaGVtYS5maWVsZHNba10udHlwZURlZikge1xuICAgICAgc2VnbWVudCA9IHV0aWwuZm9ybWF0KCdcIiVzXCIgJXMlcycsIGssIGZpZWxkVHlwZSwgc2NoZW1hLmZpZWxkc1trXS50eXBlRGVmKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc2VnbWVudCA9IHV0aWwuZm9ybWF0KCdcIiVzXCIgJXMnLCBrLCBmaWVsZFR5cGUpO1xuICAgIH1cblxuICAgIGlmIChzY2hlbWEuZmllbGRzW2tdLnN0YXRpYykge1xuICAgICAgc2VnbWVudCArPSAnIFNUQVRJQyc7XG4gICAgfVxuXG4gICAgcm93cy5wdXNoKHNlZ21lbnQpO1xuICB9KTtcblxuICBsZXQgcGFydGl0aW9uS2V5ID0gc2NoZW1hLmtleVswXTtcbiAgbGV0IGNsdXN0ZXJpbmdLZXkgPSBzY2hlbWEua2V5LnNsaWNlKDEsIHNjaGVtYS5rZXkubGVuZ3RoKTtcbiAgY29uc3QgY2x1c3RlcmluZ09yZGVyID0gW107XG5cblxuICBmb3IgKGxldCBmaWVsZCA9IDA7IGZpZWxkIDwgY2x1c3RlcmluZ0tleS5sZW5ndGg7IGZpZWxkKyspIHtcbiAgICBpZiAoc2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJcbiAgICAgICYmIHNjaGVtYS5jbHVzdGVyaW5nX29yZGVyW2NsdXN0ZXJpbmdLZXlbZmllbGRdXVxuICAgICAgJiYgc2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbY2x1c3RlcmluZ0tleVtmaWVsZF1dLnRvTG93ZXJDYXNlKCkgPT09ICdkZXNjJykge1xuICAgICAgY2x1c3RlcmluZ09yZGVyLnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIiBERVNDJywgY2x1c3RlcmluZ0tleVtmaWVsZF0pKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2x1c3RlcmluZ09yZGVyLnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIiBBU0MnLCBjbHVzdGVyaW5nS2V5W2ZpZWxkXSkpO1xuICAgIH1cbiAgfVxuXG4gIGxldCBjbHVzdGVyaW5nT3JkZXJRdWVyeSA9ICcnO1xuICBpZiAoY2x1c3RlcmluZ09yZGVyLmxlbmd0aCA+IDApIHtcbiAgICBjbHVzdGVyaW5nT3JkZXJRdWVyeSA9IHV0aWwuZm9ybWF0KCcgV0lUSCBDTFVTVEVSSU5HIE9SREVSIEJZICglcyknLCBjbHVzdGVyaW5nT3JkZXIudG9TdHJpbmcoKSk7XG4gIH1cblxuICBpZiAocGFydGl0aW9uS2V5IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICBwYXJ0aXRpb25LZXkgPSBwYXJ0aXRpb25LZXkubWFwKCh2KSA9PiAodXRpbC5mb3JtYXQoJ1wiJXNcIicsIHYpKSkuam9pbignLCcpO1xuICB9IGVsc2Uge1xuICAgIHBhcnRpdGlvbktleSA9IHV0aWwuZm9ybWF0KCdcIiVzXCInLCBwYXJ0aXRpb25LZXkpO1xuICB9XG5cbiAgaWYgKGNsdXN0ZXJpbmdLZXkubGVuZ3RoKSB7XG4gICAgY2x1c3RlcmluZ0tleSA9IGNsdXN0ZXJpbmdLZXkubWFwKCh2KSA9PiAodXRpbC5mb3JtYXQoJ1wiJXNcIicsIHYpKSkuam9pbignLCcpO1xuICAgIGNsdXN0ZXJpbmdLZXkgPSB1dGlsLmZvcm1hdCgnLCVzJywgY2x1c3RlcmluZ0tleSk7XG4gIH0gZWxzZSB7XG4gICAgY2x1c3RlcmluZ0tleSA9ICcnO1xuICB9XG5cbiAgY29uc3QgcXVlcnkgPSB1dGlsLmZvcm1hdChcbiAgICAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgXCIlc1wiICglcyAsIFBSSU1BUlkgS0VZKCglcyklcykpJXM7JyxcbiAgICB0YWJsZU5hbWUsXG4gICAgcm93cy5qb2luKCcgLCAnKSxcbiAgICBwYXJ0aXRpb25LZXksXG4gICAgY2x1c3RlcmluZ0tleSxcbiAgICBjbHVzdGVyaW5nT3JkZXJRdWVyeSxcbiAgKTtcblxuICByZXR1cm4gcXVlcnk7XG59O1xuXG5CYXNlTW9kZWwuX2NyZWF0ZV9tYXRlcmlhbGl6ZWRfdmlld19xdWVyeSA9IGZ1bmN0aW9uIGYodGFibGVOYW1lLCB2aWV3TmFtZSwgdmlld1NjaGVtYSkge1xuICBjb25zdCByb3dzID0gW107XG5cbiAgZm9yIChsZXQgayA9IDA7IGsgPCB2aWV3U2NoZW1hLnNlbGVjdC5sZW5ndGg7IGsrKykge1xuICAgIGlmICh2aWV3U2NoZW1hLnNlbGVjdFtrXSA9PT0gJyonKSByb3dzLnB1c2godXRpbC5mb3JtYXQoJyVzJywgdmlld1NjaGVtYS5zZWxlY3Rba10pKTtcbiAgICBlbHNlIHJvd3MucHVzaCh1dGlsLmZvcm1hdCgnXCIlc1wiJywgdmlld1NjaGVtYS5zZWxlY3Rba10pKTtcbiAgfVxuXG4gIGxldCBwYXJ0aXRpb25LZXkgPSB2aWV3U2NoZW1hLmtleVswXTtcbiAgbGV0IGNsdXN0ZXJpbmdLZXkgPSB2aWV3U2NoZW1hLmtleS5zbGljZSgxLCB2aWV3U2NoZW1hLmtleS5sZW5ndGgpO1xuICBjb25zdCBjbHVzdGVyaW5nT3JkZXIgPSBbXTtcblxuICBmb3IgKGxldCBmaWVsZCA9IDA7IGZpZWxkIDwgY2x1c3RlcmluZ0tleS5sZW5ndGg7IGZpZWxkKyspIHtcbiAgICBpZiAodmlld1NjaGVtYS5jbHVzdGVyaW5nX29yZGVyXG4gICAgICAmJiB2aWV3U2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbY2x1c3RlcmluZ0tleVtmaWVsZF1dXG4gICAgICAmJiB2aWV3U2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbY2x1c3RlcmluZ0tleVtmaWVsZF1dLnRvTG93ZXJDYXNlKCkgPT09ICdkZXNjJykge1xuICAgICAgY2x1c3RlcmluZ09yZGVyLnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIiBERVNDJywgY2x1c3RlcmluZ0tleVtmaWVsZF0pKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2x1c3RlcmluZ09yZGVyLnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIiBBU0MnLCBjbHVzdGVyaW5nS2V5W2ZpZWxkXSkpO1xuICAgIH1cbiAgfVxuXG4gIGxldCBjbHVzdGVyaW5nT3JkZXJRdWVyeSA9ICcnO1xuICBpZiAoY2x1c3RlcmluZ09yZGVyLmxlbmd0aCA+IDApIHtcbiAgICBjbHVzdGVyaW5nT3JkZXJRdWVyeSA9IHV0aWwuZm9ybWF0KCcgV0lUSCBDTFVTVEVSSU5HIE9SREVSIEJZICglcyknLCBjbHVzdGVyaW5nT3JkZXIudG9TdHJpbmcoKSk7XG4gIH1cblxuICBpZiAocGFydGl0aW9uS2V5IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICBwYXJ0aXRpb25LZXkgPSBwYXJ0aXRpb25LZXkubWFwKCh2KSA9PiB1dGlsLmZvcm1hdCgnXCIlc1wiJywgdikpLmpvaW4oJywnKTtcbiAgfSBlbHNlIHtcbiAgICBwYXJ0aXRpb25LZXkgPSB1dGlsLmZvcm1hdCgnXCIlc1wiJywgcGFydGl0aW9uS2V5KTtcbiAgfVxuXG4gIGlmIChjbHVzdGVyaW5nS2V5Lmxlbmd0aCkge1xuICAgIGNsdXN0ZXJpbmdLZXkgPSBjbHVzdGVyaW5nS2V5Lm1hcCgodikgPT4gKHV0aWwuZm9ybWF0KCdcIiVzXCInLCB2KSkpLmpvaW4oJywnKTtcbiAgICBjbHVzdGVyaW5nS2V5ID0gdXRpbC5mb3JtYXQoJywlcycsIGNsdXN0ZXJpbmdLZXkpO1xuICB9IGVsc2Uge1xuICAgIGNsdXN0ZXJpbmdLZXkgPSAnJztcbiAgfVxuXG4gIGxldCB3aGVyZUNsYXVzZSA9IHBhcnRpdGlvbktleS5zcGxpdCgnLCcpLmpvaW4oJyBJUyBOT1QgTlVMTCBBTkQgJyk7XG4gIGlmIChjbHVzdGVyaW5nS2V5KSB3aGVyZUNsYXVzZSArPSBjbHVzdGVyaW5nS2V5LnNwbGl0KCcsJykuam9pbignIElTIE5PVCBOVUxMIEFORCAnKTtcbiAgd2hlcmVDbGF1c2UgKz0gJyBJUyBOT1QgTlVMTCc7XG5cbiAgY29uc3QgcXVlcnkgPSB1dGlsLmZvcm1hdChcbiAgICAnQ1JFQVRFIE1BVEVSSUFMSVpFRCBWSUVXIElGIE5PVCBFWElTVFMgXCIlc1wiIEFTIFNFTEVDVCAlcyBGUk9NIFwiJXNcIiBXSEVSRSAlcyBQUklNQVJZIEtFWSgoJXMpJXMpJXM7JyxcbiAgICB2aWV3TmFtZSxcbiAgICByb3dzLmpvaW4oJyAsICcpLFxuICAgIHRhYmxlTmFtZSxcbiAgICB3aGVyZUNsYXVzZSxcbiAgICBwYXJ0aXRpb25LZXksXG4gICAgY2x1c3RlcmluZ0tleSxcbiAgICBjbHVzdGVyaW5nT3JkZXJRdWVyeSxcbiAgKTtcblxuICByZXR1cm4gcXVlcnk7XG59O1xuXG5CYXNlTW9kZWwuX2NyZWF0ZV9pbmRleF9xdWVyeSA9IGZ1bmN0aW9uIGYodGFibGVOYW1lLCBpbmRleE5hbWUpIHtcbiAgbGV0IHF1ZXJ5O1xuICBjb25zdCBpbmRleEV4cHJlc3Npb24gPSBpbmRleE5hbWUucmVwbGFjZSgvW1wiXFxzXS9nLCAnJykuc3BsaXQoL1soKV0vZyk7XG4gIGlmIChpbmRleEV4cHJlc3Npb24ubGVuZ3RoID4gMSkge1xuICAgIGluZGV4RXhwcmVzc2lvblswXSA9IGluZGV4RXhwcmVzc2lvblswXS50b0xvd2VyQ2FzZSgpO1xuICAgIHF1ZXJ5ID0gdXRpbC5mb3JtYXQoXG4gICAgICAnQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgT04gXCIlc1wiICglcyhcIiVzXCIpKTsnLFxuICAgICAgdGFibGVOYW1lLFxuICAgICAgaW5kZXhFeHByZXNzaW9uWzBdLFxuICAgICAgaW5kZXhFeHByZXNzaW9uWzFdLFxuICAgICk7XG4gIH0gZWxzZSB7XG4gICAgcXVlcnkgPSB1dGlsLmZvcm1hdChcbiAgICAgICdDUkVBVEUgSU5ERVggSUYgTk9UIEVYSVNUUyBPTiBcIiVzXCIgKFwiJXNcIik7JyxcbiAgICAgIHRhYmxlTmFtZSxcbiAgICAgIGluZGV4RXhwcmVzc2lvblswXSxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHF1ZXJ5O1xufTtcblxuQmFzZU1vZGVsLl9jcmVhdGVfY3VzdG9tX2luZGV4X3F1ZXJ5ID0gZnVuY3Rpb24gZih0YWJsZU5hbWUsIGN1c3RvbUluZGV4KSB7XG4gIGxldCBxdWVyeSA9IHV0aWwuZm9ybWF0KFxuICAgICdDUkVBVEUgQ1VTVE9NIElOREVYIElGIE5PVCBFWElTVFMgT04gXCIlc1wiIChcIiVzXCIpIFVTSU5HIFxcJyVzXFwnJyxcbiAgICB0YWJsZU5hbWUsXG4gICAgY3VzdG9tSW5kZXgub24sXG4gICAgY3VzdG9tSW5kZXgudXNpbmcsXG4gICk7XG5cbiAgaWYgKE9iamVjdC5rZXlzKGN1c3RvbUluZGV4Lm9wdGlvbnMpLmxlbmd0aCA+IDApIHtcbiAgICBxdWVyeSArPSAnIFdJVEggT1BUSU9OUyA9IHsnO1xuICAgIE9iamVjdC5rZXlzKGN1c3RvbUluZGV4Lm9wdGlvbnMpLmZvckVhY2goKGtleSkgPT4ge1xuICAgICAgcXVlcnkgKz0gdXRpbC5mb3JtYXQoXCInJXMnOiAnJXMnLCBcIiwga2V5LCBjdXN0b21JbmRleC5vcHRpb25zW2tleV0pO1xuICAgIH0pO1xuICAgIHF1ZXJ5ID0gcXVlcnkuc2xpY2UoMCwgLTIpO1xuICAgIHF1ZXJ5ICs9ICd9JztcbiAgfVxuXG4gIHF1ZXJ5ICs9ICc7JztcblxuICByZXR1cm4gcXVlcnk7XG59O1xuXG5CYXNlTW9kZWwuX2dldF9kYl90YWJsZV9zY2hlbWEgPSBmdW5jdGlvbiBmKGNhbGxiYWNrKSB7XG4gIGNvbnN0IHNlbGYgPSB0aGlzO1xuXG4gIGNvbnN0IHRhYmxlTmFtZSA9IHRoaXMuX3Byb3BlcnRpZXMudGFibGVfbmFtZTtcbiAgY29uc3Qga2V5c3BhY2UgPSB0aGlzLl9wcm9wZXJ0aWVzLmtleXNwYWNlO1xuXG4gIGxldCBxdWVyeSA9ICdTRUxFQ1QgKiBGUk9NIHN5c3RlbV9zY2hlbWEuY29sdW1ucyBXSEVSRSB0YWJsZV9uYW1lID0gPyBBTkQga2V5c3BhY2VfbmFtZSA9ID87JztcblxuICBzZWxmLmV4ZWN1dGVfcXVlcnkocXVlcnksIFt0YWJsZU5hbWUsIGtleXNwYWNlXSwgKGVyciwgcmVzdWx0Q29sdW1ucykgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJzY2hlbWFxdWVyeScsIGVycikpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmICghcmVzdWx0Q29sdW1ucy5yb3dzIHx8IHJlc3VsdENvbHVtbnMucm93cy5sZW5ndGggPT09IDApIHtcbiAgICAgIGNhbGxiYWNrKG51bGwsIG51bGwpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGRiU2NoZW1hID0geyBmaWVsZHM6IHt9LCB0eXBlTWFwczoge30sIHN0YXRpY01hcHM6IHt9IH07XG5cbiAgICBmb3IgKGxldCByID0gMDsgciA8IHJlc3VsdENvbHVtbnMucm93cy5sZW5ndGg7IHIrKykge1xuICAgICAgY29uc3Qgcm93ID0gcmVzdWx0Q29sdW1ucy5yb3dzW3JdO1xuXG4gICAgICBkYlNjaGVtYS5maWVsZHNbcm93LmNvbHVtbl9uYW1lXSA9IFRZUEVfTUFQLmV4dHJhY3RfdHlwZShyb3cudHlwZSk7XG5cbiAgICAgIGNvbnN0IHR5cGVNYXBEZWYgPSBUWVBFX01BUC5leHRyYWN0X3R5cGVEZWYocm93LnR5cGUpO1xuICAgICAgaWYgKHR5cGVNYXBEZWYubGVuZ3RoID4gMCkge1xuICAgICAgICBkYlNjaGVtYS50eXBlTWFwc1tyb3cuY29sdW1uX25hbWVdID0gdHlwZU1hcERlZjtcbiAgICAgIH1cblxuICAgICAgaWYgKHJvdy5raW5kID09PSAncGFydGl0aW9uX2tleScpIHtcbiAgICAgICAgaWYgKCFkYlNjaGVtYS5rZXkpIGRiU2NoZW1hLmtleSA9IFtbXV07XG4gICAgICAgIGRiU2NoZW1hLmtleVswXVtyb3cucG9zaXRpb25dID0gcm93LmNvbHVtbl9uYW1lO1xuICAgICAgfSBlbHNlIGlmIChyb3cua2luZCA9PT0gJ2NsdXN0ZXJpbmcnKSB7XG4gICAgICAgIGlmICghZGJTY2hlbWEua2V5KSBkYlNjaGVtYS5rZXkgPSBbW11dO1xuICAgICAgICBpZiAoIWRiU2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXIpIGRiU2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXIgPSB7fTtcblxuICAgICAgICBkYlNjaGVtYS5rZXlbcm93LnBvc2l0aW9uICsgMV0gPSByb3cuY29sdW1uX25hbWU7XG4gICAgICAgIGlmIChyb3cuY2x1c3RlcmluZ19vcmRlciAmJiByb3cuY2x1c3RlcmluZ19vcmRlci50b0xvd2VyQ2FzZSgpID09PSAnZGVzYycpIHtcbiAgICAgICAgICBkYlNjaGVtYS5jbHVzdGVyaW5nX29yZGVyW3Jvdy5jb2x1bW5fbmFtZV0gPSAnREVTQyc7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgZGJTY2hlbWEuY2x1c3RlcmluZ19vcmRlcltyb3cuY29sdW1uX25hbWVdID0gJ0FTQyc7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAocm93LmtpbmQgPT09ICdzdGF0aWMnKSB7XG4gICAgICAgIGRiU2NoZW1hLnN0YXRpY01hcHNbcm93LmNvbHVtbl9uYW1lXSA9IHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgcXVlcnkgPSAnU0VMRUNUICogRlJPTSBzeXN0ZW1fc2NoZW1hLmluZGV4ZXMgV0hFUkUgdGFibGVfbmFtZSA9ID8gQU5EIGtleXNwYWNlX25hbWUgPSA/Oyc7XG5cbiAgICBzZWxmLmV4ZWN1dGVfcXVlcnkocXVlcnksIFt0YWJsZU5hbWUsIGtleXNwYWNlXSwgKGVycjEsIHJlc3VsdEluZGV4ZXMpID0+IHtcbiAgICAgIGlmIChlcnIxKSB7XG4gICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJzY2hlbWFxdWVyeScsIGVycjEpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBmb3IgKGxldCByID0gMDsgciA8IHJlc3VsdEluZGV4ZXMucm93cy5sZW5ndGg7IHIrKykge1xuICAgICAgICBjb25zdCByb3cgPSByZXN1bHRJbmRleGVzLnJvd3Nbcl07XG5cbiAgICAgICAgLy8gSW5kZXhlcyBieSBlbGFzc2FuZHJhIGRvIG5vdCBoYXZlIHJvdy5vcHRpb25zLnRhcmdldCwgc28gd2Ugc2hvdWxkIGp1c3Qgc2tpcCB0aGVtXG4gICAgICAgIGlmIChyb3cuaW5kZXhfbmFtZSAmJiByb3cub3B0aW9ucy50YXJnZXQpIHtcbiAgICAgICAgICBjb25zdCBpbmRleE9wdGlvbnMgPSByb3cub3B0aW9ucztcbiAgICAgICAgICBsZXQgdGFyZ2V0ID0gaW5kZXhPcHRpb25zLnRhcmdldDtcbiAgICAgICAgICB0YXJnZXQgPSB0YXJnZXQucmVwbGFjZSgvW1wiXFxzXS9nLCAnJyk7XG4gICAgICAgICAgZGVsZXRlIGluZGV4T3B0aW9ucy50YXJnZXQ7XG5cbiAgICAgICAgICAvLyBrZWVwaW5nIHRyYWNrIG9mIGluZGV4IG5hbWVzIHRvIGRyb3AgaW5kZXggd2hlbiBuZWVkZWRcbiAgICAgICAgICBpZiAoIWRiU2NoZW1hLmluZGV4X25hbWVzKSBkYlNjaGVtYS5pbmRleF9uYW1lcyA9IHt9O1xuXG4gICAgICAgICAgaWYgKHJvdy5raW5kID09PSAnQ1VTVE9NJykge1xuICAgICAgICAgICAgY29uc3QgdXNpbmcgPSBpbmRleE9wdGlvbnMuY2xhc3NfbmFtZTtcbiAgICAgICAgICAgIGRlbGV0ZSBpbmRleE9wdGlvbnMuY2xhc3NfbmFtZTtcblxuICAgICAgICAgICAgaWYgKCFkYlNjaGVtYS5jdXN0b21faW5kZXhlcykgZGJTY2hlbWEuY3VzdG9tX2luZGV4ZXMgPSBbXTtcbiAgICAgICAgICAgIGNvbnN0IGN1c3RvbUluZGV4T2JqZWN0ID0ge1xuICAgICAgICAgICAgICBvbjogdGFyZ2V0LFxuICAgICAgICAgICAgICB1c2luZyxcbiAgICAgICAgICAgICAgb3B0aW9uczogaW5kZXhPcHRpb25zLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGRiU2NoZW1hLmN1c3RvbV9pbmRleGVzLnB1c2goY3VzdG9tSW5kZXhPYmplY3QpO1xuICAgICAgICAgICAgZGJTY2hlbWEuaW5kZXhfbmFtZXNbb2JqZWN0SGFzaChjdXN0b21JbmRleE9iamVjdCldID0gcm93LmluZGV4X25hbWU7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICghZGJTY2hlbWEuaW5kZXhlcykgZGJTY2hlbWEuaW5kZXhlcyA9IFtdO1xuICAgICAgICAgICAgZGJTY2hlbWEuaW5kZXhlcy5wdXNoKHRhcmdldCk7XG4gICAgICAgICAgICBkYlNjaGVtYS5pbmRleF9uYW1lc1t0YXJnZXRdID0gcm93LmluZGV4X25hbWU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHF1ZXJ5ID0gJ1NFTEVDVCB2aWV3X25hbWUsYmFzZV90YWJsZV9uYW1lIEZST00gc3lzdGVtX3NjaGVtYS52aWV3cyBXSEVSRSBrZXlzcGFjZV9uYW1lPT87JztcblxuICAgICAgc2VsZi5leGVjdXRlX3F1ZXJ5KHF1ZXJ5LCBba2V5c3BhY2VdLCAoZXJyMiwgcmVzdWx0Vmlld3MpID0+IHtcbiAgICAgICAgaWYgKGVycjIpIHtcbiAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRic2NoZW1hcXVlcnknLCBlcnIyKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgZm9yIChsZXQgciA9IDA7IHIgPCByZXN1bHRWaWV3cy5yb3dzLmxlbmd0aDsgcisrKSB7XG4gICAgICAgICAgY29uc3Qgcm93ID0gcmVzdWx0Vmlld3Mucm93c1tyXTtcblxuICAgICAgICAgIGlmIChyb3cuYmFzZV90YWJsZV9uYW1lID09PSB0YWJsZU5hbWUpIHtcbiAgICAgICAgICAgIGlmICghZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKSBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MgPSB7fTtcbiAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudmlld19uYW1lXSA9IHt9O1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MpIHtcbiAgICAgICAgICBxdWVyeSA9ICdTRUxFQ1QgKiBGUk9NIHN5c3RlbV9zY2hlbWEuY29sdW1ucyBXSEVSRSBrZXlzcGFjZV9uYW1lPT8gYW5kIHRhYmxlX25hbWUgSU4gPzsnO1xuXG4gICAgICAgICAgc2VsZi5leGVjdXRlX3F1ZXJ5KHF1ZXJ5LCBba2V5c3BhY2UsIE9iamVjdC5rZXlzKGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cyldLCAoZXJyMywgcmVzdWx0TWF0Vmlld3MpID0+IHtcbiAgICAgICAgICAgIGlmIChlcnIzKSB7XG4gICAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJzY2hlbWFxdWVyeScsIGVycjMpKTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmb3IgKGxldCByID0gMDsgciA8IHJlc3VsdE1hdFZpZXdzLnJvd3MubGVuZ3RoOyByKyspIHtcbiAgICAgICAgICAgICAgY29uc3Qgcm93ID0gcmVzdWx0TWF0Vmlld3Mucm93c1tyXTtcblxuICAgICAgICAgICAgICBpZiAoIWRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0uc2VsZWN0KSB7XG4gICAgICAgICAgICAgICAgZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5zZWxlY3QgPSBbXTtcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0uc2VsZWN0LnB1c2gocm93LmNvbHVtbl9uYW1lKTtcblxuICAgICAgICAgICAgICBpZiAocm93LmtpbmQgPT09ICdwYXJ0aXRpb25fa2V5Jykge1xuICAgICAgICAgICAgICAgIGlmICghZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5rZXkpIHtcbiAgICAgICAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0ua2V5ID0gW1tdXTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmtleVswXVtyb3cucG9zaXRpb25dID0gcm93LmNvbHVtbl9uYW1lO1xuICAgICAgICAgICAgICB9IGVsc2UgaWYgKHJvdy5raW5kID09PSAnY2x1c3RlcmluZycpIHtcbiAgICAgICAgICAgICAgICBpZiAoIWRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0ua2V5KSB7XG4gICAgICAgICAgICAgICAgICBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmtleSA9IFtbXV07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmICghZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5jbHVzdGVyaW5nX29yZGVyKSB7XG4gICAgICAgICAgICAgICAgICBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmNsdXN0ZXJpbmdfb3JkZXIgPSB7fTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmtleVtyb3cucG9zaXRpb24gKyAxXSA9IHJvdy5jb2x1bW5fbmFtZTtcbiAgICAgICAgICAgICAgICBpZiAocm93LmNsdXN0ZXJpbmdfb3JkZXIgJiYgcm93LmNsdXN0ZXJpbmdfb3JkZXIudG9Mb3dlckNhc2UoKSA9PT0gJ2Rlc2MnKSB7XG4gICAgICAgICAgICAgICAgICBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmNsdXN0ZXJpbmdfb3JkZXJbcm93LmNvbHVtbl9uYW1lXSA9ICdERVNDJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5jbHVzdGVyaW5nX29yZGVyW3Jvdy5jb2x1bW5fbmFtZV0gPSAnQVNDJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY2FsbGJhY2sobnVsbCwgZGJTY2hlbWEpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNhbGxiYWNrKG51bGwsIGRiU2NoZW1hKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLl9leGVjdXRlX3RhYmxlX3F1ZXJ5ID0gZnVuY3Rpb24gZihxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgY29uc3QgZG9FeGVjdXRlUXVlcnkgPSBmdW5jdGlvbiBmMShkb3F1ZXJ5LCBkb2NhbGxiYWNrKSB7XG4gICAgdGhpcy5leGVjdXRlX3F1ZXJ5KGRvcXVlcnksIHBhcmFtcywgb3B0aW9ucywgZG9jYWxsYmFjayk7XG4gIH0uYmluZCh0aGlzLCBxdWVyeSk7XG5cbiAgaWYgKHRoaXMuaXNfdGFibGVfcmVhZHkoKSkge1xuICAgIGRvRXhlY3V0ZVF1ZXJ5KGNhbGxiYWNrKTtcbiAgfSBlbHNlIHtcbiAgICB0aGlzLmluaXQoKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBkb0V4ZWN1dGVRdWVyeShjYWxsYmFjayk7XG4gICAgfSk7XG4gIH1cbn07XG5cbkJhc2VNb2RlbC5fZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24gPSBmdW5jdGlvbiBmKGZpZWxkbmFtZSwgZmllbGR2YWx1ZSkge1xuICBpZiAoZmllbGR2YWx1ZSA9PSBudWxsIHx8IGZpZWxkdmFsdWUgPT09IGNxbC50eXBlcy51bnNldCkge1xuICAgIHJldHVybiB7IHF1ZXJ5X3NlZ21lbnQ6ICc/JywgcGFyYW1ldGVyOiBmaWVsZHZhbHVlIH07XG4gIH1cblxuICBpZiAoXy5pc1BsYWluT2JqZWN0KGZpZWxkdmFsdWUpICYmIGZpZWxkdmFsdWUuJGRiX2Z1bmN0aW9uKSB7XG4gICAgcmV0dXJuIGZpZWxkdmFsdWUuJGRiX2Z1bmN0aW9uO1xuICB9XG5cbiAgY29uc3QgZmllbGR0eXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZSh0aGlzLl9wcm9wZXJ0aWVzLnNjaGVtYSwgZmllbGRuYW1lKTtcbiAgY29uc3QgdmFsaWRhdG9ycyA9IHRoaXMuX2dldF92YWxpZGF0b3JzKGZpZWxkbmFtZSk7XG5cbiAgaWYgKGZpZWxkdmFsdWUgaW5zdGFuY2VvZiBBcnJheSAmJiBmaWVsZHR5cGUgIT09ICdsaXN0JyAmJiBmaWVsZHR5cGUgIT09ICdzZXQnICYmIGZpZWxkdHlwZSAhPT0gJ2Zyb3plbicpIHtcbiAgICBjb25zdCB2YWwgPSBmaWVsZHZhbHVlLm1hcCgodikgPT4ge1xuICAgICAgY29uc3QgZGJWYWwgPSB0aGlzLl9nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihmaWVsZG5hbWUsIHYpO1xuXG4gICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGRiVmFsKSAmJiBkYlZhbC5xdWVyeV9zZWdtZW50KSByZXR1cm4gZGJWYWwucGFyYW1ldGVyO1xuICAgICAgcmV0dXJuIGRiVmFsO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgcXVlcnlfc2VnbWVudDogJz8nLCBwYXJhbWV0ZXI6IHZhbCB9O1xuICB9XG5cbiAgY29uc3QgdmFsaWRhdGlvbk1lc3NhZ2UgPSB0aGlzLl92YWxpZGF0ZSh2YWxpZGF0b3JzLCBmaWVsZHZhbHVlKTtcbiAgaWYgKHZhbGlkYXRpb25NZXNzYWdlICE9PSB0cnVlKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnZhbGlkYXRvci5pbnZhbGlkdmFsdWUnLCB2YWxpZGF0aW9uTWVzc2FnZShmaWVsZHZhbHVlLCBmaWVsZG5hbWUsIGZpZWxkdHlwZSkpKTtcbiAgfVxuXG4gIGlmIChmaWVsZHR5cGUgPT09ICdjb3VudGVyJykge1xuICAgIGxldCBjb3VudGVyUXVlcnlTZWdtZW50ID0gdXRpbC5mb3JtYXQoJ1wiJXNcIicsIGZpZWxkbmFtZSk7XG4gICAgaWYgKGZpZWxkdmFsdWUgPj0gMCkgY291bnRlclF1ZXJ5U2VnbWVudCArPSAnICsgPyc7XG4gICAgZWxzZSBjb3VudGVyUXVlcnlTZWdtZW50ICs9ICcgLSA/JztcbiAgICBmaWVsZHZhbHVlID0gTWF0aC5hYnMoZmllbGR2YWx1ZSk7XG4gICAgcmV0dXJuIHsgcXVlcnlfc2VnbWVudDogY291bnRlclF1ZXJ5U2VnbWVudCwgcGFyYW1ldGVyOiBmaWVsZHZhbHVlIH07XG4gIH1cblxuICByZXR1cm4geyBxdWVyeV9zZWdtZW50OiAnPycsIHBhcmFtZXRlcjogZmllbGR2YWx1ZSB9O1xufTtcblxuQmFzZU1vZGVsLl9wYXJzZV9xdWVyeV9vYmplY3QgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0KSB7XG4gIGNvbnN0IHF1ZXJ5UmVsYXRpb25zID0gW107XG4gIGNvbnN0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgT2JqZWN0LmtleXMocXVlcnlPYmplY3QpLmZvckVhY2goKGspID0+IHtcbiAgICBpZiAoay5pbmRleE9mKCckJykgPT09IDApIHtcbiAgICAgIC8vIHNlYXJjaCBxdWVyaWVzIGJhc2VkIG9uIGx1Y2VuZSBpbmRleCBvciBzb2xyXG4gICAgICAvLyBlc2NhcGUgYWxsIHNpbmdsZSBxdW90ZXMgZm9yIHF1ZXJpZXMgaW4gY2Fzc2FuZHJhXG4gICAgICBpZiAoayA9PT0gJyRleHByJykge1xuICAgICAgICBpZiAodHlwZW9mIHF1ZXJ5T2JqZWN0W2tdLmluZGV4ID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgcXVlcnlPYmplY3Rba10ucXVlcnkgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgIFwiZXhwciglcywnJXMnKVwiLFxuICAgICAgICAgICAgcXVlcnlPYmplY3Rba10uaW5kZXgsIHF1ZXJ5T2JqZWN0W2tdLnF1ZXJ5LnJlcGxhY2UoLycvZywgXCInJ1wiKSxcbiAgICAgICAgICApKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkZXhwcicpKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChrID09PSAnJHNvbHJfcXVlcnknKSB7XG4gICAgICAgIGlmICh0eXBlb2YgcXVlcnlPYmplY3Rba10gPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgIFwic29scl9xdWVyeT0nJXMnXCIsXG4gICAgICAgICAgICBxdWVyeU9iamVjdFtrXS5yZXBsYWNlKC8nL2csIFwiJydcIiksXG4gICAgICAgICAgKSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZHNvbHJxdWVyeScpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGxldCB3aGVyZU9iamVjdCA9IHF1ZXJ5T2JqZWN0W2tdO1xuICAgIC8vIEFycmF5IG9mIG9wZXJhdG9yc1xuICAgIGlmICghKHdoZXJlT2JqZWN0IGluc3RhbmNlb2YgQXJyYXkpKSB3aGVyZU9iamVjdCA9IFt3aGVyZU9iamVjdF07XG5cbiAgICBmb3IgKGxldCBmayA9IDA7IGZrIDwgd2hlcmVPYmplY3QubGVuZ3RoOyBmaysrKSB7XG4gICAgICBsZXQgZmllbGRSZWxhdGlvbiA9IHdoZXJlT2JqZWN0W2ZrXTtcblxuICAgICAgY29uc3QgY3FsT3BlcmF0b3JzID0ge1xuICAgICAgICAkZXE6ICc9JyxcbiAgICAgICAgJG5lOiAnIT0nLFxuICAgICAgICAkZ3Q6ICc+JyxcbiAgICAgICAgJGx0OiAnPCcsXG4gICAgICAgICRndGU6ICc+PScsXG4gICAgICAgICRsdGU6ICc8PScsXG4gICAgICAgICRpbjogJ0lOJyxcbiAgICAgICAgJGxpa2U6ICdMSUtFJyxcbiAgICAgICAgJHRva2VuOiAndG9rZW4nLFxuICAgICAgICAkY29udGFpbnM6ICdDT05UQUlOUycsXG4gICAgICAgICRjb250YWluc19rZXk6ICdDT05UQUlOUyBLRVknLFxuICAgICAgfTtcblxuICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChmaWVsZFJlbGF0aW9uKSkge1xuICAgICAgICBjb25zdCB2YWxpZEtleXMgPSBPYmplY3Qua2V5cyhjcWxPcGVyYXRvcnMpO1xuICAgICAgICBjb25zdCBmaWVsZFJlbGF0aW9uS2V5cyA9IE9iamVjdC5rZXlzKGZpZWxkUmVsYXRpb24pO1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGZpZWxkUmVsYXRpb25LZXlzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgaWYgKHZhbGlkS2V5cy5pbmRleE9mKGZpZWxkUmVsYXRpb25LZXlzW2ldKSA8IDApIHsgLy8gZmllbGQgcmVsYXRpb24ga2V5IGludmFsaWRcbiAgICAgICAgICAgIGZpZWxkUmVsYXRpb24gPSB7ICRlcTogZmllbGRSZWxhdGlvbiB9O1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBmaWVsZFJlbGF0aW9uID0geyAkZXE6IGZpZWxkUmVsYXRpb24gfTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVsS2V5cyA9IE9iamVjdC5rZXlzKGZpZWxkUmVsYXRpb24pO1xuICAgICAgZm9yIChsZXQgcmsgPSAwOyByayA8IHJlbEtleXMubGVuZ3RoOyByaysrKSB7XG4gICAgICAgIGxldCBmaXJzdEtleSA9IHJlbEtleXNbcmtdO1xuICAgICAgICBjb25zdCBmaXJzdFZhbHVlID0gZmllbGRSZWxhdGlvbltmaXJzdEtleV07XG4gICAgICAgIGlmIChmaXJzdEtleS50b0xvd2VyQ2FzZSgpIGluIGNxbE9wZXJhdG9ycykge1xuICAgICAgICAgIGZpcnN0S2V5ID0gZmlyc3RLZXkudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICBsZXQgb3AgPSBjcWxPcGVyYXRvcnNbZmlyc3RLZXldO1xuXG4gICAgICAgICAgaWYgKGZpcnN0S2V5ID09PSAnJGluJyAmJiAhKGZpcnN0VmFsdWUgaW5zdGFuY2VvZiBBcnJheSkpIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRpbm9wJykpO1xuICAgICAgICAgIGlmIChmaXJzdEtleSA9PT0gJyR0b2tlbicgJiYgIShmaXJzdFZhbHVlIGluc3RhbmNlb2YgT2JqZWN0KSkgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZHRva2VuJykpO1xuXG4gICAgICAgICAgbGV0IHdoZXJlVGVtcGxhdGUgPSAnXCIlc1wiICVzICVzJztcbiAgICAgICAgICBpZiAoZmlyc3RLZXkgPT09ICckdG9rZW4nKSB7XG4gICAgICAgICAgICB3aGVyZVRlbXBsYXRlID0gJ3Rva2VuKFwiJXNcIikgJXMgdG9rZW4oJXMpJztcblxuICAgICAgICAgICAgY29uc3QgdG9rZW5SZWxLZXlzID0gT2JqZWN0LmtleXMoZmlyc3RWYWx1ZSk7XG4gICAgICAgICAgICBmb3IgKGxldCB0b2tlblJLID0gMDsgdG9rZW5SSyA8IHRva2VuUmVsS2V5cy5sZW5ndGg7IHRva2VuUksrKykge1xuICAgICAgICAgICAgICBsZXQgdG9rZW5GaXJzdEtleSA9IHRva2VuUmVsS2V5c1t0b2tlblJLXTtcbiAgICAgICAgICAgICAgY29uc3QgdG9rZW5GaXJzdFZhbHVlID0gZmlyc3RWYWx1ZVt0b2tlbkZpcnN0S2V5XTtcbiAgICAgICAgICAgICAgdG9rZW5GaXJzdEtleSA9IHRva2VuRmlyc3RLZXkudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICAgICAgaWYgKCh0b2tlbkZpcnN0S2V5IGluIGNxbE9wZXJhdG9ycykgJiYgdG9rZW5GaXJzdEtleSAhPT0gJyR0b2tlbicgJiYgdG9rZW5GaXJzdEtleSAhPT0gJyRpbicpIHtcbiAgICAgICAgICAgICAgICBvcCA9IGNxbE9wZXJhdG9yc1t0b2tlbkZpcnN0S2V5XTtcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkdG9rZW5vcCcsIHRva2VuRmlyc3RLZXkpKTtcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGlmICh0b2tlbkZpcnN0VmFsdWUgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHRva2VuS2V5cyA9IGsuc3BsaXQoJywnKTtcbiAgICAgICAgICAgICAgICBmb3IgKGxldCB0b2tlbkluZGV4ID0gMDsgdG9rZW5JbmRleCA8IHRva2VuRmlyc3RWYWx1ZS5sZW5ndGg7IHRva2VuSW5kZXgrKykge1xuICAgICAgICAgICAgICAgICAgdG9rZW5LZXlzW3Rva2VuSW5kZXhdID0gdG9rZW5LZXlzW3Rva2VuSW5kZXhdLnRyaW0oKTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGRiVmFsID0gdGhpcy5fZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24odG9rZW5LZXlzW3Rva2VuSW5kZXhdLCB0b2tlbkZpcnN0VmFsdWVbdG9rZW5JbmRleF0pO1xuICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkYlZhbCkgJiYgZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgICAgICAgICAgICAgICAgICB0b2tlbkZpcnN0VmFsdWVbdG9rZW5JbmRleF0gPSBkYlZhbC5xdWVyeV9zZWdtZW50O1xuICAgICAgICAgICAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0b2tlbkZpcnN0VmFsdWVbdG9rZW5JbmRleF0gPSBkYlZhbDtcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgICAgICAgICAgICB0b2tlbktleXMuam9pbignXCIsXCInKSwgb3AsIHRva2VuRmlyc3RWYWx1ZS50b1N0cmluZygpLFxuICAgICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnN0IGRiVmFsID0gdGhpcy5fZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24oaywgdG9rZW5GaXJzdFZhbHVlKTtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGRiVmFsKSAmJiBkYlZhbC5xdWVyeV9zZWdtZW50KSB7XG4gICAgICAgICAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICAgICAgICAgICAgICBrLCBvcCwgZGJWYWwucXVlcnlfc2VnbWVudCxcbiAgICAgICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICAgICAgICAgICAgICBrLCBvcCwgZGJWYWwsXG4gICAgICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2UgaWYgKGZpcnN0S2V5ID09PSAnJGNvbnRhaW5zJykge1xuICAgICAgICAgICAgY29uc3QgZmllbGR0eXBlMSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUodGhpcy5fcHJvcGVydGllcy5zY2hlbWEsIGspO1xuICAgICAgICAgICAgaWYgKFsnbWFwJywgJ2xpc3QnLCAnc2V0JywgJ2Zyb3plbiddLmluZGV4T2YoZmllbGR0eXBlMSkgPj0gMCkge1xuICAgICAgICAgICAgICBpZiAoZmllbGR0eXBlMSA9PT0gJ21hcCcgJiYgXy5pc1BsYWluT2JqZWN0KGZpcnN0VmFsdWUpICYmIE9iamVjdC5rZXlzKGZpcnN0VmFsdWUpLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgICAnXCIlc1wiWyVzXSAlcyAlcycsXG4gICAgICAgICAgICAgICAgICBrLCAnPycsICc9JywgJz8nLFxuICAgICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goT2JqZWN0LmtleXMoZmlyc3RWYWx1ZSlbMF0pO1xuICAgICAgICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZmlyc3RWYWx1ZVtPYmplY3Qua2V5cyhmaXJzdFZhbHVlKVswXV0pO1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICAgICAgICAgICAgaywgb3AsICc/JyxcbiAgICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGZpcnN0VmFsdWUpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkY29udGFpbnNvcCcpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2UgaWYgKGZpcnN0S2V5ID09PSAnJGNvbnRhaW5zX2tleScpIHtcbiAgICAgICAgICAgIGNvbnN0IGZpZWxkdHlwZTIgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHRoaXMuX3Byb3BlcnRpZXMuc2NoZW1hLCBrKTtcbiAgICAgICAgICAgIGlmIChbJ21hcCddLmluZGV4T2YoZmllbGR0eXBlMikgPj0gMCkge1xuICAgICAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgICAgICAgICAgaywgb3AsICc/JyxcbiAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZmlyc3RWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkY29udGFpbnNrZXlvcCcpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgZGJWYWwgPSB0aGlzLl9nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihrLCBmaXJzdFZhbHVlKTtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHtcbiAgICAgICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICAgICAgICAgIGssIG9wLCBkYlZhbC5xdWVyeV9zZWdtZW50LFxuICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICAgICAgICAgIGssIG9wLCBkYlZhbCxcbiAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRvcCcsIGZpcnN0S2V5KSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiB7XG4gICAgcXVlcnlSZWxhdGlvbnMsXG4gICAgcXVlcnlQYXJhbXMsXG4gIH07XG59O1xuXG5CYXNlTW9kZWwuX2NyZWF0ZV93aGVyZV9jbGF1c2UgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0KSB7XG4gIGNvbnN0IHBhcnNlZE9iamVjdCA9IHRoaXMuX3BhcnNlX3F1ZXJ5X29iamVjdChxdWVyeU9iamVjdCk7XG4gIGNvbnN0IHdoZXJlQ2xhdXNlID0ge307XG4gIGlmIChwYXJzZWRPYmplY3QucXVlcnlSZWxhdGlvbnMubGVuZ3RoID4gMCkge1xuICAgIHdoZXJlQ2xhdXNlLnF1ZXJ5ID0gdXRpbC5mb3JtYXQoJ1dIRVJFICVzJywgcGFyc2VkT2JqZWN0LnF1ZXJ5UmVsYXRpb25zLmpvaW4oJyBBTkQgJykpO1xuICB9IGVsc2Uge1xuICAgIHdoZXJlQ2xhdXNlLnF1ZXJ5ID0gJyc7XG4gIH1cbiAgd2hlcmVDbGF1c2UucGFyYW1zID0gcGFyc2VkT2JqZWN0LnF1ZXJ5UGFyYW1zO1xuICByZXR1cm4gd2hlcmVDbGF1c2U7XG59O1xuXG5CYXNlTW9kZWwuX2NyZWF0ZV9pZl9jbGF1c2UgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0KSB7XG4gIGNvbnN0IHBhcnNlZE9iamVjdCA9IHRoaXMuX3BhcnNlX3F1ZXJ5X29iamVjdChxdWVyeU9iamVjdCk7XG4gIGNvbnN0IGlmQ2xhdXNlID0ge307XG4gIGlmIChwYXJzZWRPYmplY3QucXVlcnlSZWxhdGlvbnMubGVuZ3RoID4gMCkge1xuICAgIGlmQ2xhdXNlLnF1ZXJ5ID0gdXRpbC5mb3JtYXQoJ0lGICVzJywgcGFyc2VkT2JqZWN0LnF1ZXJ5UmVsYXRpb25zLmpvaW4oJyBBTkQgJykpO1xuICB9IGVsc2Uge1xuICAgIGlmQ2xhdXNlLnF1ZXJ5ID0gJyc7XG4gIH1cbiAgaWZDbGF1c2UucGFyYW1zID0gcGFyc2VkT2JqZWN0LnF1ZXJ5UGFyYW1zO1xuICByZXR1cm4gaWZDbGF1c2U7XG59O1xuXG5CYXNlTW9kZWwuX2NyZWF0ZV9maW5kX3F1ZXJ5ID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCwgb3B0aW9ucykge1xuICBjb25zdCBvcmRlcktleXMgPSBbXTtcbiAgbGV0IGxpbWl0ID0gbnVsbDtcblxuICBPYmplY3Qua2V5cyhxdWVyeU9iamVjdCkuZm9yRWFjaCgoaykgPT4ge1xuICAgIGNvbnN0IHF1ZXJ5SXRlbSA9IHF1ZXJ5T2JqZWN0W2tdO1xuICAgIGlmIChrLnRvTG93ZXJDYXNlKCkgPT09ICckb3JkZXJieScpIHtcbiAgICAgIGlmICghKHF1ZXJ5SXRlbSBpbnN0YW5jZW9mIE9iamVjdCkpIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZG9yZGVyJykpO1xuICAgICAgfVxuICAgICAgY29uc3Qgb3JkZXJJdGVtS2V5cyA9IE9iamVjdC5rZXlzKHF1ZXJ5SXRlbSk7XG5cbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgb3JkZXJJdGVtS2V5cy5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCBjcWxPcmRlckRpcmVjdGlvbiA9IHsgJGFzYzogJ0FTQycsICRkZXNjOiAnREVTQycgfTtcbiAgICAgICAgaWYgKG9yZGVySXRlbUtleXNbaV0udG9Mb3dlckNhc2UoKSBpbiBjcWxPcmRlckRpcmVjdGlvbikge1xuICAgICAgICAgIGxldCBvcmRlckZpZWxkcyA9IHF1ZXJ5SXRlbVtvcmRlckl0ZW1LZXlzW2ldXTtcblxuICAgICAgICAgIGlmICghKG9yZGVyRmllbGRzIGluc3RhbmNlb2YgQXJyYXkpKSBvcmRlckZpZWxkcyA9IFtvcmRlckZpZWxkc107XG5cbiAgICAgICAgICBmb3IgKGxldCBqID0gMDsgaiA8IG9yZGVyRmllbGRzLmxlbmd0aDsgaisrKSB7XG4gICAgICAgICAgICBvcmRlcktleXMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgJ1wiJXNcIiAlcycsXG4gICAgICAgICAgICAgIG9yZGVyRmllbGRzW2pdLCBjcWxPcmRlckRpcmVjdGlvbltvcmRlckl0ZW1LZXlzW2ldXSxcbiAgICAgICAgICAgICkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkb3JkZXJ0eXBlJywgb3JkZXJJdGVtS2V5c1tpXSkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChrLnRvTG93ZXJDYXNlKCkgPT09ICckbGltaXQnKSB7XG4gICAgICBpZiAodHlwZW9mIHF1ZXJ5SXRlbSAhPT0gJ251bWJlcicpIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmxpbWl0dHlwZScpKTtcbiAgICAgIGxpbWl0ID0gcXVlcnlJdGVtO1xuICAgIH1cbiAgfSk7XG5cbiAgY29uc3Qgd2hlcmVDbGF1c2UgPSB0aGlzLl9jcmVhdGVfd2hlcmVfY2xhdXNlKHF1ZXJ5T2JqZWN0KTtcblxuICBsZXQgc2VsZWN0ID0gJyonO1xuICBpZiAob3B0aW9ucy5zZWxlY3QgJiYgXy5pc0FycmF5KG9wdGlvbnMuc2VsZWN0KSAmJiBvcHRpb25zLnNlbGVjdC5sZW5ndGggPiAwKSB7XG4gICAgY29uc3Qgc2VsZWN0QXJyYXkgPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG9wdGlvbnMuc2VsZWN0Lmxlbmd0aDsgaSsrKSB7XG4gICAgICAvLyBzZXBhcmF0ZSB0aGUgYWdncmVnYXRlIGZ1bmN0aW9uIGFuZCB0aGUgY29sdW1uIG5hbWUgaWYgc2VsZWN0IGlzIGFuIGFnZ3JlZ2F0ZSBmdW5jdGlvblxuICAgICAgY29uc3Qgc2VsZWN0aW9uID0gb3B0aW9ucy5zZWxlY3RbaV0uc3BsaXQoL1soICldL2cpLmZpbHRlcigoZSkgPT4gKGUpKTtcbiAgICAgIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAxKSB7XG4gICAgICAgIHNlbGVjdEFycmF5LnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIicsIHNlbGVjdGlvblswXSkpO1xuICAgICAgfSBlbHNlIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAyIHx8IHNlbGVjdGlvbi5sZW5ndGggPT09IDQpIHtcbiAgICAgICAgbGV0IGZ1bmN0aW9uQ2xhdXNlID0gdXRpbC5mb3JtYXQoJyVzKFwiJXNcIiknLCBzZWxlY3Rpb25bMF0sIHNlbGVjdGlvblsxXSk7XG4gICAgICAgIGlmIChzZWxlY3Rpb25bMl0pIGZ1bmN0aW9uQ2xhdXNlICs9IHV0aWwuZm9ybWF0KCcgJXMnLCBzZWxlY3Rpb25bMl0pO1xuICAgICAgICBpZiAoc2VsZWN0aW9uWzNdKSBmdW5jdGlvbkNsYXVzZSArPSB1dGlsLmZvcm1hdCgnICVzJywgc2VsZWN0aW9uWzNdKTtcblxuICAgICAgICBzZWxlY3RBcnJheS5wdXNoKGZ1bmN0aW9uQ2xhdXNlKTtcbiAgICAgIH0gZWxzZSBpZiAoc2VsZWN0aW9uLmxlbmd0aCA9PT0gMykge1xuICAgICAgICBzZWxlY3RBcnJheS5wdXNoKHV0aWwuZm9ybWF0KCdcIiVzXCIgJXMgJXMnLCBzZWxlY3Rpb25bMF0sIHNlbGVjdGlvblsxXSwgc2VsZWN0aW9uWzJdKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZWxlY3RBcnJheS5wdXNoKCcqJyk7XG4gICAgICB9XG4gICAgfVxuICAgIHNlbGVjdCA9IHNlbGVjdEFycmF5LmpvaW4oJywnKTtcbiAgfVxuXG4gIGxldCBxdWVyeSA9IHV0aWwuZm9ybWF0KFxuICAgICdTRUxFQ1QgJXMgJXMgRlJPTSBcIiVzXCIgJXMgJXMgJXMnLFxuICAgIChvcHRpb25zLmRpc3RpbmN0ID8gJ0RJU1RJTkNUJyA6ICcnKSxcbiAgICBzZWxlY3QsXG4gICAgb3B0aW9ucy5tYXRlcmlhbGl6ZWRfdmlldyA/IG9wdGlvbnMubWF0ZXJpYWxpemVkX3ZpZXcgOiB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWUsXG4gICAgd2hlcmVDbGF1c2UucXVlcnksXG4gICAgb3JkZXJLZXlzLmxlbmd0aCA/IHV0aWwuZm9ybWF0KCdPUkRFUiBCWSAlcycsIG9yZGVyS2V5cy5qb2luKCcsICcpKSA6ICcgJyxcbiAgICBsaW1pdCA/IHV0aWwuZm9ybWF0KCdMSU1JVCAlcycsIGxpbWl0KSA6ICcgJyxcbiAgKTtcblxuICBpZiAob3B0aW9ucy5hbGxvd19maWx0ZXJpbmcpIHF1ZXJ5ICs9ICcgQUxMT1cgRklMVEVSSU5HOyc7XG4gIGVsc2UgcXVlcnkgKz0gJzsnO1xuXG4gIHJldHVybiB7IHF1ZXJ5LCBwYXJhbXM6IHdoZXJlQ2xhdXNlLnBhcmFtcyB9O1xufTtcblxuQmFzZU1vZGVsLmdldF90YWJsZV9uYW1lID0gZnVuY3Rpb24gZigpIHtcbiAgcmV0dXJuIHRoaXMuX3Byb3BlcnRpZXMudGFibGVfbmFtZTtcbn07XG5cbkJhc2VNb2RlbC5pc190YWJsZV9yZWFkeSA9IGZ1bmN0aW9uIGYoKSB7XG4gIHJldHVybiB0aGlzLl9yZWFkeSA9PT0gdHJ1ZTtcbn07XG5cbkJhc2VNb2RlbC5pbml0ID0gZnVuY3Rpb24gZihvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoIWNhbGxiYWNrKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSB1bmRlZmluZWQ7XG4gIH1cblxuICB0aGlzLl9yZWFkeSA9IHRydWU7XG4gIGNhbGxiYWNrKCk7XG59O1xuXG5CYXNlTW9kZWwuc3luY0RlZmluaXRpb24gPSBmdW5jdGlvbiBmKGNhbGxiYWNrKSB7XG4gIGNvbnN0IGFmdGVyQ3JlYXRlID0gKGVyciwgcmVzdWx0KSA9PiB7XG4gICAgaWYgKGVycikgY2FsbGJhY2soZXJyKTtcbiAgICBlbHNlIHtcbiAgICAgIHRoaXMuX3JlYWR5ID0gdHJ1ZTtcbiAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdCk7XG4gICAgfVxuICB9O1xuXG4gIHRoaXMuX2NyZWF0ZV90YWJsZShhZnRlckNyZWF0ZSk7XG59O1xuXG5CYXNlTW9kZWwuZXhlY3V0ZV9xdWVyeSA9IGZ1bmN0aW9uIGYocXVlcnksIHBhcmFtcywgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDMpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIHRoaXMuX2Vuc3VyZV9jb25uZWN0ZWQoKGVycikgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGRlYnVnKCdleGVjdXRpbmcgcXVlcnk6ICVzIHdpdGggcGFyYW1zOiAlaicsIHF1ZXJ5LCBwYXJhbXMpO1xuICAgIHRoaXMuX3Byb3BlcnRpZXMuY3FsLmV4ZWN1dGUocXVlcnksIHBhcmFtcywgb3B0aW9ucywgKGVycjEsIHJlc3VsdCkgPT4ge1xuICAgICAgaWYgKGVycjEgJiYgZXJyMS5jb2RlID09PSA4NzA0KSB7XG4gICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShxdWVyeSwgcGFyYW1zLCBjYWxsYmFjayk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjYWxsYmFjayhlcnIxLCByZXN1bHQpO1xuICAgICAgfVxuICAgIH0pO1xuICB9KTtcbn07XG5cbkJhc2VNb2RlbC5leGVjdXRlX2VhY2hSb3cgPSBmdW5jdGlvbiBmKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gIHRoaXMuX2Vuc3VyZV9jb25uZWN0ZWQoKGVycikgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGRlYnVnKCdleGVjdXRpbmcgZWFjaFJvdyBxdWVyeTogJXMgd2l0aCBwYXJhbXM6ICVqJywgcXVlcnksIHBhcmFtcyk7XG4gICAgdGhpcy5fcHJvcGVydGllcy5jcWwuZWFjaFJvdyhxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjayk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLl9leGVjdXRlX3RhYmxlX2VhY2hSb3cgPSBmdW5jdGlvbiBmKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gIGlmICh0aGlzLmlzX3RhYmxlX3JlYWR5KCkpIHtcbiAgICB0aGlzLmV4ZWN1dGVfZWFjaFJvdyhxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjayk7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5pbml0KChlcnIpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5leGVjdXRlX2VhY2hSb3cocXVlcnksIHBhcmFtcywgb3B0aW9ucywgb25SZWFkYWJsZSwgY2FsbGJhY2spO1xuICAgIH0pO1xuICB9XG59O1xuXG5CYXNlTW9kZWwuZWFjaFJvdyA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAzKSB7XG4gICAgY29uc3QgY2IgPSBvblJlYWRhYmxlO1xuICAgIG9uUmVhZGFibGUgPSBvcHRpb25zO1xuICAgIGNhbGxiYWNrID0gY2I7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG4gIGlmICh0eXBlb2Ygb25SZWFkYWJsZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmVhY2hyb3dlcnJvcicsICdubyB2YWxpZCBvblJlYWRhYmxlIGZ1bmN0aW9uIHdhcyBwcm92aWRlZCcpKTtcbiAgfVxuICBpZiAodHlwZW9mIGNhbGxiYWNrICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuY2JlcnJvcicpKTtcbiAgfVxuXG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHJhdzogZmFsc2UsXG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIG9wdGlvbnMucmV0dXJuX3F1ZXJ5ID0gdHJ1ZTtcbiAgY29uc3Qgc2VsZWN0UXVlcnkgPSB0aGlzLmZpbmQocXVlcnlPYmplY3QsIG9wdGlvbnMpO1xuXG4gIGNvbnN0IHF1ZXJ5T3B0aW9ucyA9IHsgcHJlcGFyZTogb3B0aW9ucy5wcmVwYXJlIH07XG4gIGlmIChvcHRpb25zLmNvbnNpc3RlbmN5KSBxdWVyeU9wdGlvbnMuY29uc2lzdGVuY3kgPSBvcHRpb25zLmNvbnNpc3RlbmN5O1xuICBpZiAob3B0aW9ucy5mZXRjaFNpemUpIHF1ZXJ5T3B0aW9ucy5mZXRjaFNpemUgPSBvcHRpb25zLmZldGNoU2l6ZTtcbiAgaWYgKG9wdGlvbnMuYXV0b1BhZ2UpIHF1ZXJ5T3B0aW9ucy5hdXRvUGFnZSA9IG9wdGlvbnMuYXV0b1BhZ2U7XG4gIGlmIChvcHRpb25zLmhpbnRzKSBxdWVyeU9wdGlvbnMuaGludHMgPSBvcHRpb25zLmhpbnRzO1xuICBpZiAob3B0aW9ucy5wYWdlU3RhdGUpIHF1ZXJ5T3B0aW9ucy5wYWdlU3RhdGUgPSBvcHRpb25zLnBhZ2VTdGF0ZTtcbiAgaWYgKG9wdGlvbnMucmV0cnkpIHF1ZXJ5T3B0aW9ucy5yZXRyeSA9IG9wdGlvbnMucmV0cnk7XG4gIGlmIChvcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5KSBxdWVyeU9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3kgPSBvcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5O1xuXG4gIHRoaXMuX2V4ZWN1dGVfdGFibGVfZWFjaFJvdyhzZWxlY3RRdWVyeS5xdWVyeSwgc2VsZWN0UXVlcnkucGFyYW1zLCBxdWVyeU9wdGlvbnMsIChuLCByb3cpID0+IHtcbiAgICBpZiAoIW9wdGlvbnMucmF3KSB7XG4gICAgICBjb25zdCBNb2RlbENvbnN0cnVjdG9yID0gdGhpcy5fcHJvcGVydGllcy5nZXRfY29uc3RydWN0b3IoKTtcbiAgICAgIHJvdyA9IG5ldyBNb2RlbENvbnN0cnVjdG9yKHJvdyk7XG4gICAgICByb3cuX21vZGlmaWVkID0ge307XG4gICAgfVxuICAgIG9uUmVhZGFibGUobiwgcm93KTtcbiAgfSwgKGVyciwgcmVzdWx0KSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZmluZC5kYmVycm9yJywgZXJyKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNhbGxiYWNrKGVyciwgcmVzdWx0KTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuZXhlY3V0ZV9zdHJlYW0gPSBmdW5jdGlvbiBmKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gIHRoaXMuX2Vuc3VyZV9jb25uZWN0ZWQoKGVycikgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGRlYnVnKCdleGVjdXRpbmcgc3RyZWFtIHF1ZXJ5OiAlcyB3aXRoIHBhcmFtczogJWonLCBxdWVyeSwgcGFyYW1zKTtcbiAgICB0aGlzLl9wcm9wZXJ0aWVzLmNxbC5zdHJlYW0ocXVlcnksIHBhcmFtcywgb3B0aW9ucykub24oJ3JlYWRhYmxlJywgb25SZWFkYWJsZSkub24oJ2VuZCcsIGNhbGxiYWNrKTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuX2V4ZWN1dGVfdGFibGVfc3RyZWFtID0gZnVuY3Rpb24gZihxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjaykge1xuICBpZiAodGhpcy5pc190YWJsZV9yZWFkeSgpKSB7XG4gICAgdGhpcy5leGVjdXRlX3N0cmVhbShxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjayk7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5pbml0KChlcnIpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5leGVjdXRlX3N0cmVhbShxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjayk7XG4gICAgfSk7XG4gIH1cbn07XG5cbkJhc2VNb2RlbC5zdHJlYW0gPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0LCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMykge1xuICAgIGNvbnN0IGNiID0gb25SZWFkYWJsZTtcbiAgICBvblJlYWRhYmxlID0gb3B0aW9ucztcbiAgICBjYWxsYmFjayA9IGNiO1xuICAgIG9wdGlvbnMgPSB7fTtcbiAgfVxuXG4gIGlmICh0eXBlb2Ygb25SZWFkYWJsZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLnN0cmVhbWVycm9yJywgJ25vIHZhbGlkIG9uUmVhZGFibGUgZnVuY3Rpb24gd2FzIHByb3ZpZGVkJykpO1xuICB9XG4gIGlmICh0eXBlb2YgY2FsbGJhY2sgIT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5jYmVycm9yJykpO1xuICB9XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcmF3OiBmYWxzZSxcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgb3B0aW9ucy5yZXR1cm5fcXVlcnkgPSB0cnVlO1xuICBjb25zdCBzZWxlY3RRdWVyeSA9IHRoaXMuZmluZChxdWVyeU9iamVjdCwgb3B0aW9ucyk7XG5cbiAgY29uc3QgcXVlcnlPcHRpb25zID0geyBwcmVwYXJlOiBvcHRpb25zLnByZXBhcmUgfTtcbiAgaWYgKG9wdGlvbnMuY29uc2lzdGVuY3kpIHF1ZXJ5T3B0aW9ucy5jb25zaXN0ZW5jeSA9IG9wdGlvbnMuY29uc2lzdGVuY3k7XG4gIGlmIChvcHRpb25zLmZldGNoU2l6ZSkgcXVlcnlPcHRpb25zLmZldGNoU2l6ZSA9IG9wdGlvbnMuZmV0Y2hTaXplO1xuICBpZiAob3B0aW9ucy5hdXRvUGFnZSkgcXVlcnlPcHRpb25zLmF1dG9QYWdlID0gb3B0aW9ucy5hdXRvUGFnZTtcbiAgaWYgKG9wdGlvbnMuaGludHMpIHF1ZXJ5T3B0aW9ucy5oaW50cyA9IG9wdGlvbnMuaGludHM7XG4gIGlmIChvcHRpb25zLnBhZ2VTdGF0ZSkgcXVlcnlPcHRpb25zLnBhZ2VTdGF0ZSA9IG9wdGlvbnMucGFnZVN0YXRlO1xuICBpZiAob3B0aW9ucy5yZXRyeSkgcXVlcnlPcHRpb25zLnJldHJ5ID0gb3B0aW9ucy5yZXRyeTtcbiAgaWYgKG9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3kpIHF1ZXJ5T3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeSA9IG9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3k7XG5cbiAgY29uc3Qgc2VsZiA9IHRoaXM7XG5cbiAgdGhpcy5fZXhlY3V0ZV90YWJsZV9zdHJlYW0oc2VsZWN0UXVlcnkucXVlcnksIHNlbGVjdFF1ZXJ5LnBhcmFtcywgcXVlcnlPcHRpb25zLCBmdW5jdGlvbiBmMSgpIHtcbiAgICBjb25zdCByZWFkZXIgPSB0aGlzO1xuICAgIHJlYWRlci5yZWFkUm93ID0gKCkgPT4ge1xuICAgICAgY29uc3Qgcm93ID0gcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmICghcm93KSByZXR1cm4gcm93O1xuICAgICAgaWYgKCFvcHRpb25zLnJhdykge1xuICAgICAgICBjb25zdCBNb2RlbENvbnN0cnVjdG9yID0gc2VsZi5fcHJvcGVydGllcy5nZXRfY29uc3RydWN0b3IoKTtcbiAgICAgICAgY29uc3QgbyA9IG5ldyBNb2RlbENvbnN0cnVjdG9yKHJvdyk7XG4gICAgICAgIG8uX21vZGlmaWVkID0ge307XG4gICAgICAgIHJldHVybiBvO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJvdztcbiAgICB9O1xuICAgIG9uUmVhZGFibGUocmVhZGVyKTtcbiAgfSwgKGVycikgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuZGJlcnJvcicsIGVycikpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjYWxsYmFjaygpO1xuICB9KTtcbn07XG5cbkJhc2VNb2RlbC5maW5kID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCwgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDIgJiYgdHlwZW9mIG9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG4gIGlmICh0eXBlb2YgY2FsbGJhY2sgIT09ICdmdW5jdGlvbicgJiYgIW9wdGlvbnMucmV0dXJuX3F1ZXJ5KSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuY2JlcnJvcicpKTtcbiAgfVxuXG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHJhdzogZmFsc2UsXG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIC8vIHNldCByYXcgdHJ1ZSBpZiBzZWxlY3QgaXMgdXNlZCxcbiAgLy8gYmVjYXVzZSBjYXN0aW5nIHRvIG1vZGVsIGluc3RhbmNlcyBtYXkgbGVhZCB0byBwcm9ibGVtc1xuICBpZiAob3B0aW9ucy5zZWxlY3QpIG9wdGlvbnMucmF3ID0gdHJ1ZTtcblxuICBsZXQgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBsZXQgcXVlcnk7XG4gIHRyeSB7XG4gICAgY29uc3QgZmluZFF1ZXJ5ID0gdGhpcy5fY3JlYXRlX2ZpbmRfcXVlcnkocXVlcnlPYmplY3QsIG9wdGlvbnMpO1xuICAgIHF1ZXJ5ID0gZmluZFF1ZXJ5LnF1ZXJ5O1xuICAgIHF1ZXJ5UGFyYW1zID0gcXVlcnlQYXJhbXMuY29uY2F0KGZpbmRRdWVyeS5wYXJhbXMpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgY2FsbGJhY2soZSk7XG4gICAgICByZXR1cm4ge307XG4gICAgfVxuICAgIHRocm93IChlKTtcbiAgfVxuXG4gIGlmIChvcHRpb25zLnJldHVybl9xdWVyeSkge1xuICAgIHJldHVybiB7IHF1ZXJ5LCBwYXJhbXM6IHF1ZXJ5UGFyYW1zIH07XG4gIH1cblxuICBjb25zdCBxdWVyeU9wdGlvbnMgPSB7IHByZXBhcmU6IG9wdGlvbnMucHJlcGFyZSB9O1xuICBpZiAob3B0aW9ucy5jb25zaXN0ZW5jeSkgcXVlcnlPcHRpb25zLmNvbnNpc3RlbmN5ID0gb3B0aW9ucy5jb25zaXN0ZW5jeTtcbiAgaWYgKG9wdGlvbnMuZmV0Y2hTaXplKSBxdWVyeU9wdGlvbnMuZmV0Y2hTaXplID0gb3B0aW9ucy5mZXRjaFNpemU7XG4gIGlmIChvcHRpb25zLmF1dG9QYWdlKSBxdWVyeU9wdGlvbnMuYXV0b1BhZ2UgPSBvcHRpb25zLmF1dG9QYWdlO1xuICBpZiAob3B0aW9ucy5oaW50cykgcXVlcnlPcHRpb25zLmhpbnRzID0gb3B0aW9ucy5oaW50cztcbiAgaWYgKG9wdGlvbnMucGFnZVN0YXRlKSBxdWVyeU9wdGlvbnMucGFnZVN0YXRlID0gb3B0aW9ucy5wYWdlU3RhdGU7XG4gIGlmIChvcHRpb25zLnJldHJ5KSBxdWVyeU9wdGlvbnMucmV0cnkgPSBvcHRpb25zLnJldHJ5O1xuICBpZiAob3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeSkgcXVlcnlPcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5ID0gb3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeTtcblxuICB0aGlzLl9leGVjdXRlX3RhYmxlX3F1ZXJ5KHF1ZXJ5LCBxdWVyeVBhcmFtcywgcXVlcnlPcHRpb25zLCAoZXJyLCByZXN1bHRzKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZmluZC5kYmVycm9yJywgZXJyKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghb3B0aW9ucy5yYXcpIHtcbiAgICAgIGNvbnN0IE1vZGVsQ29uc3RydWN0b3IgPSB0aGlzLl9wcm9wZXJ0aWVzLmdldF9jb25zdHJ1Y3RvcigpO1xuICAgICAgcmVzdWx0cyA9IHJlc3VsdHMucm93cy5tYXAoKHJlcykgPT4ge1xuICAgICAgICBkZWxldGUgKHJlcy5jb2x1bW5zKTtcbiAgICAgICAgY29uc3QgbyA9IG5ldyBNb2RlbENvbnN0cnVjdG9yKHJlcyk7XG4gICAgICAgIG8uX21vZGlmaWVkID0ge307XG4gICAgICAgIHJldHVybiBvO1xuICAgICAgfSk7XG4gICAgICBjYWxsYmFjayhudWxsLCByZXN1bHRzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVzdWx0cyA9IHJlc3VsdHMucm93cy5tYXAoKHJlcykgPT4ge1xuICAgICAgICBkZWxldGUgKHJlcy5jb2x1bW5zKTtcbiAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgIH0pO1xuICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0cyk7XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4ge307XG59O1xuXG5CYXNlTW9kZWwuZmluZE9uZSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAyICYmIHR5cGVvZiBvcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSB7fTtcbiAgfVxuICBpZiAodHlwZW9mIGNhbGxiYWNrICE9PSAnZnVuY3Rpb24nICYmICFvcHRpb25zLnJldHVybl9xdWVyeSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmNiZXJyb3InKSk7XG4gIH1cblxuICBxdWVyeU9iamVjdC4kbGltaXQgPSAxO1xuXG4gIHJldHVybiB0aGlzLmZpbmQocXVlcnlPYmplY3QsIG9wdGlvbnMsIChlcnIsIHJlc3VsdHMpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICBjYWxsYmFjayhudWxsLCByZXN1bHRzWzBdKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY2FsbGJhY2soKTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwudXBkYXRlID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCwgdXBkYXRlVmFsdWVzLCBvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMyAmJiB0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICBjb25zdCBzY2hlbWEgPSB0aGlzLl9wcm9wZXJ0aWVzLnNjaGVtYTtcblxuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgbGV0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgY29uc3QgdXBkYXRlQ2xhdXNlQXJyYXkgPSBbXTtcblxuICBjb25zdCBlcnJvckhhcHBlbmVkID0gT2JqZWN0LmtleXModXBkYXRlVmFsdWVzKS5zb21lKChrZXkpID0+IHtcbiAgICBpZiAoc2NoZW1hLmZpZWxkc1trZXldID09PSB1bmRlZmluZWQgfHwgc2NoZW1hLmZpZWxkc1trZXldLnZpcnR1YWwpIHJldHVybiBmYWxzZTtcblxuICAgIC8vIGNoZWNrIGZpZWxkIHZhbHVlXG4gICAgY29uc3QgZmllbGR0eXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGtleSk7XG4gICAgbGV0IGZpZWxkdmFsdWUgPSB1cGRhdGVWYWx1ZXNba2V5XTtcblxuICAgIGlmIChmaWVsZHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGZpZWxkdmFsdWUgPSB0aGlzLl9nZXRfZGVmYXVsdF92YWx1ZShrZXkpO1xuICAgICAgaWYgKGZpZWxkdmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAoc2NoZW1hLmtleS5pbmRleE9mKGtleSkgPj0gMCB8fCBzY2hlbWEua2V5WzBdLmluZGV4T2Yoa2V5KSA+PSAwKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLnVuc2V0a2V5Jywga2V5KSk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS51bnNldGtleScsIGtleSkpO1xuICAgICAgICB9IGVsc2UgaWYgKHNjaGVtYS5maWVsZHNba2V5XS5ydWxlICYmIHNjaGVtYS5maWVsZHNba2V5XS5ydWxlLnJlcXVpcmVkKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLnVuc2V0cmVxdWlyZWQnLCBrZXkpKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLnVuc2V0cmVxdWlyZWQnLCBrZXkpKTtcbiAgICAgICAgfSBlbHNlIHJldHVybiBmYWxzZTtcbiAgICAgIH0gZWxzZSBpZiAoIXNjaGVtYS5maWVsZHNba2V5XS5ydWxlIHx8ICFzY2hlbWEuZmllbGRzW2tleV0ucnVsZS5pZ25vcmVfZGVmYXVsdCkge1xuICAgICAgICAvLyBkaWQgc2V0IGEgZGVmYXVsdCB2YWx1ZSwgaWdub3JlIGRlZmF1bHQgaXMgbm90IHNldFxuICAgICAgICBpZiAodGhpcy52YWxpZGF0ZShrZXksIGZpZWxkdmFsdWUpICE9PSB0cnVlKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmludmFsaWRkZWZhdWx0dmFsdWUnLCBmaWVsZHZhbHVlLCBrZXksIGZpZWxkdHlwZSkpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuaW52YWxpZGRlZmF1bHR2YWx1ZScsIGZpZWxkdmFsdWUsIGtleSwgZmllbGR0eXBlKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZmllbGR2YWx1ZSA9PT0gbnVsbCB8fCBmaWVsZHZhbHVlID09PSBjcWwudHlwZXMudW5zZXQpIHtcbiAgICAgIGlmIChzY2hlbWEua2V5LmluZGV4T2Yoa2V5KSA+PSAwIHx8IHNjaGVtYS5rZXlbMF0uaW5kZXhPZihrZXkpID49IDApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS51bnNldGtleScsIGtleSkpO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC51cGRhdGUudW5zZXRrZXknLCBrZXkpKTtcbiAgICAgIH0gZWxzZSBpZiAoc2NoZW1hLmZpZWxkc1trZXldLnJ1bGUgJiYgc2NoZW1hLmZpZWxkc1trZXldLnJ1bGUucmVxdWlyZWQpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS51bnNldHJlcXVpcmVkJywga2V5KSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS51bnNldHJlcXVpcmVkJywga2V5KSk7XG4gICAgICB9XG4gICAgfVxuXG5cbiAgICB0cnkge1xuICAgICAgbGV0ICRhZGQgPSBmYWxzZTtcbiAgICAgIGxldCAkYXBwZW5kID0gZmFsc2U7XG4gICAgICBsZXQgJHByZXBlbmQgPSBmYWxzZTtcbiAgICAgIGxldCAkcmVwbGFjZSA9IGZhbHNlO1xuICAgICAgbGV0ICRyZW1vdmUgPSBmYWxzZTtcbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZmllbGR2YWx1ZSkpIHtcbiAgICAgICAgaWYgKGZpZWxkdmFsdWUuJGFkZCkge1xuICAgICAgICAgIGZpZWxkdmFsdWUgPSBmaWVsZHZhbHVlLiRhZGQ7XG4gICAgICAgICAgJGFkZCA9IHRydWU7XG4gICAgICAgIH0gZWxzZSBpZiAoZmllbGR2YWx1ZS4kYXBwZW5kKSB7XG4gICAgICAgICAgZmllbGR2YWx1ZSA9IGZpZWxkdmFsdWUuJGFwcGVuZDtcbiAgICAgICAgICAkYXBwZW5kID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIGlmIChmaWVsZHZhbHVlLiRwcmVwZW5kKSB7XG4gICAgICAgICAgZmllbGR2YWx1ZSA9IGZpZWxkdmFsdWUuJHByZXBlbmQ7XG4gICAgICAgICAgJHByZXBlbmQgPSB0cnVlO1xuICAgICAgICB9IGVsc2UgaWYgKGZpZWxkdmFsdWUuJHJlcGxhY2UpIHtcbiAgICAgICAgICBmaWVsZHZhbHVlID0gZmllbGR2YWx1ZS4kcmVwbGFjZTtcbiAgICAgICAgICAkcmVwbGFjZSA9IHRydWU7XG4gICAgICAgIH0gZWxzZSBpZiAoZmllbGR2YWx1ZS4kcmVtb3ZlKSB7XG4gICAgICAgICAgZmllbGR2YWx1ZSA9IGZpZWxkdmFsdWUuJHJlbW92ZTtcbiAgICAgICAgICAkcmVtb3ZlID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCBkYlZhbCA9IHRoaXMuX2dldF9kYl92YWx1ZV9leHByZXNzaW9uKGtleSwgZmllbGR2YWx1ZSk7XG5cbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHtcbiAgICAgICAgaWYgKFsnbWFwJywgJ2xpc3QnLCAnc2V0J10uaW5kZXhPZihmaWVsZHR5cGUpID4gLTEpIHtcbiAgICAgICAgICBpZiAoJGFkZCB8fCAkYXBwZW5kKSB7XG4gICAgICAgICAgICBkYlZhbC5xdWVyeV9zZWdtZW50ID0gdXRpbC5mb3JtYXQoJ1wiJXNcIiArICVzJywga2V5LCBkYlZhbC5xdWVyeV9zZWdtZW50KTtcbiAgICAgICAgICB9IGVsc2UgaWYgKCRwcmVwZW5kKSB7XG4gICAgICAgICAgICBpZiAoZmllbGR0eXBlID09PSAnbGlzdCcpIHtcbiAgICAgICAgICAgICAgZGJWYWwucXVlcnlfc2VnbWVudCA9IHV0aWwuZm9ybWF0KCclcyArIFwiJXNcIicsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQsIGtleSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcihcbiAgICAgICAgICAgICAgICAnbW9kZWwudXBkYXRlLmludmFsaWRwcmVwZW5kb3AnLFxuICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KCclcyBkYXRhdHlwZXMgZG9lcyBub3Qgc3VwcG9ydCAkcHJlcGVuZCwgdXNlICRhZGQgaW5zdGVhZCcsIGZpZWxkdHlwZSksXG4gICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSBpZiAoJHJlbW92ZSkge1xuICAgICAgICAgICAgZGJWYWwucXVlcnlfc2VnbWVudCA9IHV0aWwuZm9ybWF0KCdcIiVzXCIgLSAlcycsIGtleSwgZGJWYWwucXVlcnlfc2VnbWVudCk7XG4gICAgICAgICAgICBpZiAoZmllbGR0eXBlID09PSAnbWFwJykgZGJWYWwucGFyYW1ldGVyID0gT2JqZWN0LmtleXMoZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJHJlcGxhY2UpIHtcbiAgICAgICAgICBpZiAoZmllbGR0eXBlID09PSAnbWFwJykge1xuICAgICAgICAgICAgdXBkYXRlQ2xhdXNlQXJyYXkucHVzaCh1dGlsLmZvcm1hdCgnXCIlc1wiWz9dPSVzJywga2V5LCBkYlZhbC5xdWVyeV9zZWdtZW50KSk7XG4gICAgICAgICAgICBjb25zdCByZXBsYWNlS2V5cyA9IE9iamVjdC5rZXlzKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICAgICAgICBjb25zdCByZXBsYWNlVmFsdWVzID0gXy52YWx1ZXMoZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgICAgICAgIGlmIChyZXBsYWNlS2V5cy5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChyZXBsYWNlS2V5c1swXSk7XG4gICAgICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2gocmVwbGFjZVZhbHVlc1swXSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB0aHJvdyAoXG4gICAgICAgICAgICAgICAgYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmludmFsaWRyZXBsYWNlb3AnLCAnJHJlcGxhY2UgaW4gbWFwIGRvZXMgbm90IHN1cHBvcnQgbW9yZSB0aGFuIG9uZSBpdGVtJylcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkdHlwZSA9PT0gJ2xpc3QnKSB7XG4gICAgICAgICAgICB1cGRhdGVDbGF1c2VBcnJheS5wdXNoKHV0aWwuZm9ybWF0KCdcIiVzXCJbP109JXMnLCBrZXksIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpKTtcbiAgICAgICAgICAgIGlmIChkYlZhbC5wYXJhbWV0ZXIubGVuZ3RoID09PSAyKSB7XG4gICAgICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyWzBdKTtcbiAgICAgICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXJbMV0pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoXG4gICAgICAgICAgICAgICAgJ21vZGVsLnVwZGF0ZS5pbnZhbGlkcmVwbGFjZW9wJyxcbiAgICAgICAgICAgICAgICAnJHJlcGxhY2UgaW4gbGlzdCBzaG91bGQgaGF2ZSBleGFjdGx5IDIgaXRlbXMsIGZpcnN0IG9uZSBhcyB0aGUgaW5kZXggYW5kIHRoZSBzZWNvbmQgb25lIGFzIHRoZSB2YWx1ZScsXG4gICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcihcbiAgICAgICAgICAgICAgJ21vZGVsLnVwZGF0ZS5pbnZhbGlkcmVwbGFjZW9wJyxcbiAgICAgICAgICAgICAgdXRpbC5mb3JtYXQoJyVzIGRhdGF0eXBlcyBkb2VzIG5vdCBzdXBwb3J0ICRyZXBsYWNlJywgZmllbGR0eXBlKSxcbiAgICAgICAgICAgICkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB1cGRhdGVDbGF1c2VBcnJheS5wdXNoKHV0aWwuZm9ybWF0KCdcIiVzXCI9JXMnLCBrZXksIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpKTtcbiAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHVwZGF0ZUNsYXVzZUFycmF5LnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIj0lcycsIGtleSwgZGJWYWwpKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGNhbGxiYWNrKGUpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIHRocm93IChlKTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9KTtcblxuICBpZiAoZXJyb3JIYXBwZW5lZCkgcmV0dXJuIHt9O1xuXG4gIGxldCBxdWVyeSA9ICdVUERBVEUgXCIlc1wiJztcbiAgbGV0IHdoZXJlID0gJyc7XG4gIGlmIChvcHRpb25zLnR0bCkgcXVlcnkgKz0gdXRpbC5mb3JtYXQoJyBVU0lORyBUVEwgJXMnLCBvcHRpb25zLnR0bCk7XG4gIHF1ZXJ5ICs9ICcgU0VUICVzICVzJztcbiAgdHJ5IHtcbiAgICBjb25zdCB3aGVyZUNsYXVzZSA9IHRoaXMuX2NyZWF0ZV93aGVyZV9jbGF1c2UocXVlcnlPYmplY3QpO1xuICAgIHdoZXJlID0gd2hlcmVDbGF1c2UucXVlcnk7XG4gICAgcXVlcnlQYXJhbXMgPSBxdWVyeVBhcmFtcy5jb25jYXQod2hlcmVDbGF1c2UucGFyYW1zKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGNhbGxiYWNrKGUpO1xuICAgICAgcmV0dXJuIHt9O1xuICAgIH1cbiAgICB0aHJvdyAoZSk7XG4gIH1cbiAgcXVlcnkgPSB1dGlsLmZvcm1hdChxdWVyeSwgdGhpcy5fcHJvcGVydGllcy50YWJsZV9uYW1lLCB1cGRhdGVDbGF1c2VBcnJheS5qb2luKCcsICcpLCB3aGVyZSk7XG5cbiAgaWYgKG9wdGlvbnMuY29uZGl0aW9ucykge1xuICAgIGNvbnN0IGlmQ2xhdXNlID0gdGhpcy5fY3JlYXRlX2lmX2NsYXVzZShvcHRpb25zLmNvbmRpdGlvbnMpO1xuICAgIGlmIChpZkNsYXVzZS5xdWVyeSkge1xuICAgICAgcXVlcnkgKz0gdXRpbC5mb3JtYXQoJyAlcycsIGlmQ2xhdXNlLnF1ZXJ5KTtcbiAgICAgIHF1ZXJ5UGFyYW1zID0gcXVlcnlQYXJhbXMuY29uY2F0KGlmQ2xhdXNlLnBhcmFtcyk7XG4gICAgfVxuICB9IGVsc2UgaWYgKG9wdGlvbnMuaWZfZXhpc3RzKSB7XG4gICAgcXVlcnkgKz0gJyBJRiBFWElTVFMnO1xuICB9XG5cbiAgcXVlcnkgKz0gJzsnO1xuXG4gIC8vIHNldCBkdW1teSBob29rIGZ1bmN0aW9uIGlmIG5vdCBwcmVzZW50IGluIHNjaGVtYVxuICBpZiAodHlwZW9mIHNjaGVtYS5iZWZvcmVfdXBkYXRlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgc2NoZW1hLmJlZm9yZV91cGRhdGUgPSBmdW5jdGlvbiBmMShxdWVyeU9iaiwgdXBkYXRlVmFsLCBvcHRpb25zT2JqLCBuZXh0KSB7XG4gICAgICBuZXh0KCk7XG4gICAgfTtcbiAgfVxuXG4gIGlmICh0eXBlb2Ygc2NoZW1hLmFmdGVyX3VwZGF0ZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHNjaGVtYS5hZnRlcl91cGRhdGUgPSBmdW5jdGlvbiBmMShxdWVyeU9iaiwgdXBkYXRlVmFsLCBvcHRpb25zT2JqLCBuZXh0KSB7XG4gICAgICBuZXh0KCk7XG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhvb2tSdW5uZXIoZm4sIGVycm9yQ29kZSkge1xuICAgIHJldHVybiAoaG9va0NhbGxiYWNrKSA9PiB7XG4gICAgICBmbihxdWVyeU9iamVjdCwgdXBkYXRlVmFsdWVzLCBvcHRpb25zLCAoZXJyb3IpID0+IHtcbiAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgaG9va0NhbGxiYWNrKGJ1aWxkRXJyb3IoZXJyb3JDb2RlLCBlcnJvcikpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBob29rQ2FsbGJhY2soKTtcbiAgICAgIH0pO1xuICAgIH07XG4gIH1cblxuICBpZiAob3B0aW9ucy5yZXR1cm5fcXVlcnkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgcXVlcnksXG4gICAgICBwYXJhbXM6IHF1ZXJ5UGFyYW1zLFxuICAgICAgYmVmb3JlX2hvb2s6IGhvb2tSdW5uZXIoc2NoZW1hLmJlZm9yZV91cGRhdGUsICdtb2RlbC51cGRhdGUuYmVmb3JlLmVycm9yJyksXG4gICAgICBhZnRlcl9ob29rOiBob29rUnVubmVyKHNjaGVtYS5hZnRlcl91cGRhdGUsICdtb2RlbC51cGRhdGUuYWZ0ZXIuZXJyb3InKSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgcXVlcnlPcHRpb25zID0geyBwcmVwYXJlOiBvcHRpb25zLnByZXBhcmUgfTtcbiAgaWYgKG9wdGlvbnMuY29uc2lzdGVuY3kpIHF1ZXJ5T3B0aW9ucy5jb25zaXN0ZW5jeSA9IG9wdGlvbnMuY29uc2lzdGVuY3k7XG4gIGlmIChvcHRpb25zLmZldGNoU2l6ZSkgcXVlcnlPcHRpb25zLmZldGNoU2l6ZSA9IG9wdGlvbnMuZmV0Y2hTaXplO1xuICBpZiAob3B0aW9ucy5hdXRvUGFnZSkgcXVlcnlPcHRpb25zLmF1dG9QYWdlID0gb3B0aW9ucy5hdXRvUGFnZTtcbiAgaWYgKG9wdGlvbnMuaGludHMpIHF1ZXJ5T3B0aW9ucy5oaW50cyA9IG9wdGlvbnMuaGludHM7XG4gIGlmIChvcHRpb25zLnBhZ2VTdGF0ZSkgcXVlcnlPcHRpb25zLnBhZ2VTdGF0ZSA9IG9wdGlvbnMucGFnZVN0YXRlO1xuICBpZiAob3B0aW9ucy5yZXRyeSkgcXVlcnlPcHRpb25zLnJldHJ5ID0gb3B0aW9ucy5yZXRyeTtcbiAgaWYgKG9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3kpIHF1ZXJ5T3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeSA9IG9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3k7XG5cbiAgc2NoZW1hLmJlZm9yZV91cGRhdGUocXVlcnlPYmplY3QsIHVwZGF0ZVZhbHVlcywgb3B0aW9ucywgKGVycm9yKSA9PiB7XG4gICAgaWYgKGVycm9yKSB7XG4gICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5iZWZvcmUuZXJyb3InLCBlcnJvcikpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmJlZm9yZS5lcnJvcicsIGVycm9yKSk7XG4gICAgfVxuXG4gICAgdGhpcy5fZXhlY3V0ZV90YWJsZV9xdWVyeShxdWVyeSwgcXVlcnlQYXJhbXMsIHF1ZXJ5T3B0aW9ucywgKGVyciwgcmVzdWx0cykgPT4ge1xuICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmRiZXJyb3InLCBlcnIpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2NoZW1hLmFmdGVyX3VwZGF0ZShxdWVyeU9iamVjdCwgdXBkYXRlVmFsdWVzLCBvcHRpb25zLCAoZXJyb3IxKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yMSkge1xuICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmFmdGVyLmVycm9yJywgZXJyb3IxKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdHMpO1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSBpZiAoZXJyKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuZGJlcnJvcicsIGVycikpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2NoZW1hLmFmdGVyX3VwZGF0ZShxdWVyeU9iamVjdCwgdXBkYXRlVmFsdWVzLCBvcHRpb25zLCAoZXJyb3IxKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yMSkge1xuICAgICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5hZnRlci5lcnJvcicsIGVycm9yMSkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xuXG4gIHJldHVybiB7fTtcbn07XG5cbkJhc2VNb2RlbC5kZWxldGUgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0LCBvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMiAmJiB0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICBjb25zdCBzY2hlbWEgPSB0aGlzLl9wcm9wZXJ0aWVzLnNjaGVtYTtcblxuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgbGV0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgbGV0IHF1ZXJ5ID0gJ0RFTEVURSBGUk9NIFwiJXNcIiAlczsnO1xuICBsZXQgd2hlcmUgPSAnJztcbiAgdHJ5IHtcbiAgICBjb25zdCB3aGVyZUNsYXVzZSA9IHRoaXMuX2NyZWF0ZV93aGVyZV9jbGF1c2UocXVlcnlPYmplY3QpO1xuICAgIHdoZXJlID0gd2hlcmVDbGF1c2UucXVlcnk7XG4gICAgcXVlcnlQYXJhbXMgPSBxdWVyeVBhcmFtcy5jb25jYXQod2hlcmVDbGF1c2UucGFyYW1zKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGNhbGxiYWNrKGUpO1xuICAgICAgcmV0dXJuIHt9O1xuICAgIH1cbiAgICB0aHJvdyAoZSk7XG4gIH1cblxuICBxdWVyeSA9IHV0aWwuZm9ybWF0KHF1ZXJ5LCB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWUsIHdoZXJlKTtcblxuICAvLyBzZXQgZHVtbXkgaG9vayBmdW5jdGlvbiBpZiBub3QgcHJlc2VudCBpbiBzY2hlbWFcbiAgaWYgKHR5cGVvZiBzY2hlbWEuYmVmb3JlX2RlbGV0ZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHNjaGVtYS5iZWZvcmVfZGVsZXRlID0gZnVuY3Rpb24gZjEocXVlcnlPYmosIG9wdGlvbnNPYmosIG5leHQpIHtcbiAgICAgIG5leHQoKTtcbiAgICB9O1xuICB9XG5cbiAgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfZGVsZXRlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgc2NoZW1hLmFmdGVyX2RlbGV0ZSA9IGZ1bmN0aW9uIGYxKHF1ZXJ5T2JqLCBvcHRpb25zT2JqLCBuZXh0KSB7XG4gICAgICBuZXh0KCk7XG4gICAgfTtcbiAgfVxuXG4gIGlmIChvcHRpb25zLnJldHVybl9xdWVyeSkge1xuICAgIHJldHVybiB7XG4gICAgICBxdWVyeSxcbiAgICAgIHBhcmFtczogcXVlcnlQYXJhbXMsXG4gICAgICBiZWZvcmVfaG9vazogKGhvb2tDYWxsYmFjaykgPT4ge1xuICAgICAgICBzY2hlbWEuYmVmb3JlX2RlbGV0ZShxdWVyeU9iamVjdCwgb3B0aW9ucywgKGVycm9yKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgICBob29rQ2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZGVsZXRlLmJlZm9yZS5lcnJvcicsIGVycm9yKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGhvb2tDYWxsYmFjaygpO1xuICAgICAgICB9KTtcbiAgICAgIH0sXG4gICAgICBhZnRlcl9ob29rOiAoaG9va0NhbGxiYWNrKSA9PiB7XG4gICAgICAgIHNjaGVtYS5hZnRlcl9kZWxldGUocXVlcnlPYmplY3QsIG9wdGlvbnMsIChlcnJvcikgPT4ge1xuICAgICAgICAgIGlmIChlcnJvcikge1xuICAgICAgICAgICAgaG9va0NhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLmRlbGV0ZS5hZnRlci5lcnJvcicsIGVycm9yKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGhvb2tDYWxsYmFjaygpO1xuICAgICAgICB9KTtcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHF1ZXJ5T3B0aW9ucyA9IHsgcHJlcGFyZTogb3B0aW9ucy5wcmVwYXJlIH07XG4gIGlmIChvcHRpb25zLmNvbnNpc3RlbmN5KSBxdWVyeU9wdGlvbnMuY29uc2lzdGVuY3kgPSBvcHRpb25zLmNvbnNpc3RlbmN5O1xuICBpZiAob3B0aW9ucy5mZXRjaFNpemUpIHF1ZXJ5T3B0aW9ucy5mZXRjaFNpemUgPSBvcHRpb25zLmZldGNoU2l6ZTtcbiAgaWYgKG9wdGlvbnMuYXV0b1BhZ2UpIHF1ZXJ5T3B0aW9ucy5hdXRvUGFnZSA9IG9wdGlvbnMuYXV0b1BhZ2U7XG4gIGlmIChvcHRpb25zLmhpbnRzKSBxdWVyeU9wdGlvbnMuaGludHMgPSBvcHRpb25zLmhpbnRzO1xuICBpZiAob3B0aW9ucy5wYWdlU3RhdGUpIHF1ZXJ5T3B0aW9ucy5wYWdlU3RhdGUgPSBvcHRpb25zLnBhZ2VTdGF0ZTtcbiAgaWYgKG9wdGlvbnMucmV0cnkpIHF1ZXJ5T3B0aW9ucy5yZXRyeSA9IG9wdGlvbnMucmV0cnk7XG4gIGlmIChvcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5KSBxdWVyeU9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3kgPSBvcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5O1xuXG4gIHNjaGVtYS5iZWZvcmVfZGVsZXRlKHF1ZXJ5T2JqZWN0LCBvcHRpb25zLCAoZXJyb3IpID0+IHtcbiAgICBpZiAoZXJyb3IpIHtcbiAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZGVsZXRlLmJlZm9yZS5lcnJvcicsIGVycm9yKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5kZWxldGUuYmVmb3JlLmVycm9yJywgZXJyb3IpKTtcbiAgICB9XG5cbiAgICB0aGlzLl9leGVjdXRlX3RhYmxlX3F1ZXJ5KHF1ZXJ5LCBxdWVyeVBhcmFtcywgcXVlcnlPcHRpb25zLCAoZXJyLCByZXN1bHRzKSA9PiB7XG4gICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5kZWxldGUuZGJlcnJvcicsIGVycikpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBzY2hlbWEuYWZ0ZXJfZGVsZXRlKHF1ZXJ5T2JqZWN0LCBvcHRpb25zLCAoZXJyb3IxKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yMSkge1xuICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZGVsZXRlLmFmdGVyLmVycm9yJywgZXJyb3IxKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdHMpO1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSBpZiAoZXJyKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5kZWxldGUuZGJlcnJvcicsIGVycikpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2NoZW1hLmFmdGVyX2RlbGV0ZShxdWVyeU9iamVjdCwgb3B0aW9ucywgKGVycm9yMSkgPT4ge1xuICAgICAgICAgIGlmIChlcnJvcjEpIHtcbiAgICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5kZWxldGUuYWZ0ZXIuZXJyb3InLCBlcnJvcjEpKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICB9KTtcblxuICByZXR1cm4ge307XG59O1xuXG5CYXNlTW9kZWwudHJ1bmNhdGUgPSBmdW5jdGlvbiBmKGNhbGxiYWNrKSB7XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wZXJ0aWVzLnRhYmxlX25hbWU7XG5cbiAgY29uc3QgcXVlcnkgPSB1dGlsLmZvcm1hdCgnVFJVTkNBVEUgVEFCTEUgXCIlc1wiOycsIHRhYmxlTmFtZSk7XG4gIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShxdWVyeSwgW10sIGNhbGxiYWNrKTtcbn07XG5cbkJhc2VNb2RlbC5kcm9wX212aWV3cyA9IGZ1bmN0aW9uIGYobXZpZXdzLCBjYWxsYmFjaykge1xuICBhc3luYy5lYWNoKG12aWV3cywgKHZpZXcsIHZpZXdDYWxsYmFjaykgPT4ge1xuICAgIGNvbnN0IHF1ZXJ5ID0gdXRpbC5mb3JtYXQoJ0RST1AgTUFURVJJQUxJWkVEIFZJRVcgSUYgRVhJU1RTIFwiJXNcIjsnLCB2aWV3KTtcbiAgICB0aGlzLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkocXVlcnksIFtdLCB2aWV3Q2FsbGJhY2spO1xuICB9LCAoZXJyKSA9PiB7XG4gICAgaWYgKGVycikgY2FsbGJhY2soZXJyKTtcbiAgICBlbHNlIGNhbGxiYWNrKCk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLmRyb3BfaW5kZXhlcyA9IGZ1bmN0aW9uIGYoaW5kZXhlcywgY2FsbGJhY2spIHtcbiAgYXN5bmMuZWFjaChpbmRleGVzLCAoaW5kZXgsIGluZGV4Q2FsbGJhY2spID0+IHtcbiAgICBjb25zdCBxdWVyeSA9IHV0aWwuZm9ybWF0KCdEUk9QIElOREVYIElGIEVYSVNUUyBcIiVzXCI7JywgaW5kZXgpO1xuICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShxdWVyeSwgW10sIGluZGV4Q2FsbGJhY2spO1xuICB9LCAoZXJyKSA9PiB7XG4gICAgaWYgKGVycikgY2FsbGJhY2soZXJyKTtcbiAgICBlbHNlIGNhbGxiYWNrKCk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLmFsdGVyX3RhYmxlID0gZnVuY3Rpb24gZihvcGVyYXRpb24sIGZpZWxkbmFtZSwgdHlwZSwgY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcblxuICBpZiAob3BlcmF0aW9uID09PSAnQUxURVInKSB0eXBlID0gdXRpbC5mb3JtYXQoJ1RZUEUgJXMnLCB0eXBlKTtcbiAgZWxzZSBpZiAob3BlcmF0aW9uID09PSAnRFJPUCcpIHR5cGUgPSAnJztcblxuICBjb25zdCBxdWVyeSA9IHV0aWwuZm9ybWF0KCdBTFRFUiBUQUJMRSBcIiVzXCIgJXMgXCIlc1wiICVzOycsIHRhYmxlTmFtZSwgb3BlcmF0aW9uLCBmaWVsZG5hbWUsIHR5cGUpO1xuICB0aGlzLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkocXVlcnksIFtdLCBjYWxsYmFjayk7XG59O1xuXG5CYXNlTW9kZWwuZHJvcF90YWJsZSA9IGZ1bmN0aW9uIGYoY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcblxuICBjb25zdCBxdWVyeSA9IHV0aWwuZm9ybWF0KCdEUk9QIFRBQkxFIElGIEVYSVNUUyBcIiVzXCI7JywgdGFibGVOYW1lKTtcbiAgdGhpcy5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KHF1ZXJ5LCBbXSwgY2FsbGJhY2spO1xufTtcblxuQmFzZU1vZGVsLnByb3RvdHlwZS5fZ2V0X2RhdGFfdHlwZXMgPSBmdW5jdGlvbiBmKCkge1xuICByZXR1cm4gY3FsLnR5cGVzO1xufTtcblxuQmFzZU1vZGVsLnByb3RvdHlwZS5fZ2V0X2RlZmF1bHRfdmFsdWUgPSBmdW5jdGlvbiBmKGZpZWxkbmFtZSkge1xuICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcztcbiAgY29uc3Qgc2NoZW1hID0gcHJvcGVydGllcy5zY2hlbWE7XG5cbiAgaWYgKF8uaXNQbGFpbk9iamVjdChzY2hlbWEuZmllbGRzW2ZpZWxkbmFtZV0pICYmIHNjaGVtYS5maWVsZHNbZmllbGRuYW1lXS5kZWZhdWx0ICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAodHlwZW9mIHNjaGVtYS5maWVsZHNbZmllbGRuYW1lXS5kZWZhdWx0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICByZXR1cm4gc2NoZW1hLmZpZWxkc1tmaWVsZG5hbWVdLmRlZmF1bHQuY2FsbCh0aGlzKTtcbiAgICB9XG4gICAgcmV0dXJuIHNjaGVtYS5maWVsZHNbZmllbGRuYW1lXS5kZWZhdWx0O1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLnZhbGlkYXRlID0gZnVuY3Rpb24gZihwcm9wZXJ0eU5hbWUsIHZhbHVlKSB7XG4gIHZhbHVlID0gdmFsdWUgfHwgdGhpc1twcm9wZXJ0eU5hbWVdO1xuICB0aGlzLl92YWxpZGF0b3JzID0gdGhpcy5fdmFsaWRhdG9ycyB8fCB7fTtcbiAgcmV0dXJuIHRoaXMuY29uc3RydWN0b3IuX3ZhbGlkYXRlKHRoaXMuX3ZhbGlkYXRvcnNbcHJvcGVydHlOYW1lXSB8fCBbXSwgdmFsdWUpO1xufTtcblxuQmFzZU1vZGVsLnByb3RvdHlwZS5zYXZlID0gZnVuY3Rpb24gZm4ob3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDEgJiYgdHlwZW9mIG9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3QgaWRlbnRpZmllcnMgPSBbXTtcbiAgY29uc3QgdmFsdWVzID0gW107XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLmNvbnN0cnVjdG9yLl9wcm9wZXJ0aWVzO1xuICBjb25zdCBzY2hlbWEgPSBwcm9wZXJ0aWVzLnNjaGVtYTtcblxuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgY29uc3QgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBjb25zdCBlcnJvckhhcHBlbmVkID0gT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuc29tZSgoZikgPT4ge1xuICAgIGlmIChzY2hlbWEuZmllbGRzW2ZdLnZpcnR1YWwpIHJldHVybiBmYWxzZTtcblxuICAgIC8vIGNoZWNrIGZpZWxkIHZhbHVlXG4gICAgY29uc3QgZmllbGR0eXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGYpO1xuICAgIGxldCBmaWVsZHZhbHVlID0gdGhpc1tmXTtcblxuICAgIGlmIChmaWVsZHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGZpZWxkdmFsdWUgPSB0aGlzLl9nZXRfZGVmYXVsdF92YWx1ZShmKTtcbiAgICAgIGlmIChmaWVsZHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgaWYgKHNjaGVtYS5rZXkuaW5kZXhPZihmKSA+PSAwIHx8IHNjaGVtYS5rZXlbMF0uaW5kZXhPZihmKSA+PSAwKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuc2F2ZS51bnNldGtleScsIGYpKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuc2F2ZS51bnNldGtleScsIGYpKTtcbiAgICAgICAgfSBlbHNlIGlmIChzY2hlbWEuZmllbGRzW2ZdLnJ1bGUgJiYgc2NoZW1hLmZpZWxkc1tmXS5ydWxlLnJlcXVpcmVkKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuc2F2ZS51bnNldHJlcXVpcmVkJywgZikpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5zYXZlLnVuc2V0cmVxdWlyZWQnLCBmKSk7XG4gICAgICAgIH0gZWxzZSByZXR1cm4gZmFsc2U7XG4gICAgICB9IGVsc2UgaWYgKCFzY2hlbWEuZmllbGRzW2ZdLnJ1bGUgfHwgIXNjaGVtYS5maWVsZHNbZl0ucnVsZS5pZ25vcmVfZGVmYXVsdCkge1xuICAgICAgICAvLyBkaWQgc2V0IGEgZGVmYXVsdCB2YWx1ZSwgaWdub3JlIGRlZmF1bHQgaXMgbm90IHNldFxuICAgICAgICBpZiAodGhpcy52YWxpZGF0ZShmLCBmaWVsZHZhbHVlKSAhPT0gdHJ1ZSkge1xuICAgICAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuaW52YWxpZGRlZmF1bHR2YWx1ZScsIGZpZWxkdmFsdWUsIGYsIGZpZWxkdHlwZSkpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5zYXZlLmludmFsaWRkZWZhdWx0dmFsdWUnLCBmaWVsZHZhbHVlLCBmLCBmaWVsZHR5cGUpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChmaWVsZHZhbHVlID09PSBudWxsIHx8IGZpZWxkdmFsdWUgPT09IGNxbC50eXBlcy51bnNldCkge1xuICAgICAgaWYgKHNjaGVtYS5rZXkuaW5kZXhPZihmKSA+PSAwIHx8IHNjaGVtYS5rZXlbMF0uaW5kZXhPZihmKSA+PSAwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5zYXZlLnVuc2V0a2V5JywgZikpO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5zYXZlLnVuc2V0a2V5JywgZikpO1xuICAgICAgfSBlbHNlIGlmIChzY2hlbWEuZmllbGRzW2ZdLnJ1bGUgJiYgc2NoZW1hLmZpZWxkc1tmXS5ydWxlLnJlcXVpcmVkKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5zYXZlLnVuc2V0cmVxdWlyZWQnLCBmKSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUudW5zZXRyZXF1aXJlZCcsIGYpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZGVudGlmaWVycy5wdXNoKHV0aWwuZm9ybWF0KCdcIiVzXCInLCBmKSk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgZGJWYWwgPSB0aGlzLmNvbnN0cnVjdG9yLl9nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihmLCBmaWVsZHZhbHVlKTtcbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHtcbiAgICAgICAgdmFsdWVzLnB1c2goZGJWYWwucXVlcnlfc2VnbWVudCk7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZhbHVlcy5wdXNoKGRiVmFsKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGNhbGxiYWNrKGUpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIHRocm93IChlKTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9KTtcblxuICBpZiAoZXJyb3JIYXBwZW5lZCkgcmV0dXJuIHt9O1xuXG4gIGxldCBxdWVyeSA9IHV0aWwuZm9ybWF0KFxuICAgICdJTlNFUlQgSU5UTyBcIiVzXCIgKCAlcyApIFZBTFVFUyAoICVzICknLFxuICAgIHByb3BlcnRpZXMudGFibGVfbmFtZSxcbiAgICBpZGVudGlmaWVycy5qb2luKCcgLCAnKSxcbiAgICB2YWx1ZXMuam9pbignICwgJyksXG4gICk7XG5cbiAgaWYgKG9wdGlvbnMuaWZfbm90X2V4aXN0KSBxdWVyeSArPSAnIElGIE5PVCBFWElTVFMnO1xuICBpZiAob3B0aW9ucy50dGwpIHF1ZXJ5ICs9IHV0aWwuZm9ybWF0KCcgVVNJTkcgVFRMICVzJywgb3B0aW9ucy50dGwpO1xuXG4gIHF1ZXJ5ICs9ICc7JztcblxuICAvLyBzZXQgZHVtbXkgaG9vayBmdW5jdGlvbiBpZiBub3QgcHJlc2VudCBpbiBzY2hlbWFcbiAgaWYgKHR5cGVvZiBzY2hlbWEuYmVmb3JlX3NhdmUgIT09ICdmdW5jdGlvbicpIHtcbiAgICBzY2hlbWEuYmVmb3JlX3NhdmUgPSBmdW5jdGlvbiBmKGluc3RhbmNlLCBvcHRpb24sIG5leHQpIHtcbiAgICAgIG5leHQoKTtcbiAgICB9O1xuICB9XG5cbiAgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfc2F2ZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHNjaGVtYS5hZnRlcl9zYXZlID0gZnVuY3Rpb24gZihpbnN0YW5jZSwgb3B0aW9uLCBuZXh0KSB7XG4gICAgICBuZXh0KCk7XG4gICAgfTtcbiAgfVxuXG4gIGlmIChvcHRpb25zLnJldHVybl9xdWVyeSkge1xuICAgIHJldHVybiB7XG4gICAgICBxdWVyeSxcbiAgICAgIHBhcmFtczogcXVlcnlQYXJhbXMsXG4gICAgICBiZWZvcmVfaG9vazogKGhvb2tDYWxsYmFjaykgPT4ge1xuICAgICAgICBzY2hlbWEuYmVmb3JlX3NhdmUodGhpcywgb3B0aW9ucywgKGVycm9yKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgICBob29rQ2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5iZWZvcmUuZXJyb3InLCBlcnJvcikpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBob29rQ2FsbGJhY2soKTtcbiAgICAgICAgfSk7XG4gICAgICB9LFxuICAgICAgYWZ0ZXJfaG9vazogKGhvb2tDYWxsYmFjaykgPT4ge1xuICAgICAgICBzY2hlbWEuYWZ0ZXJfc2F2ZSh0aGlzLCBvcHRpb25zLCAoZXJyb3IpID0+IHtcbiAgICAgICAgICBpZiAoZXJyb3IpIHtcbiAgICAgICAgICAgIGhvb2tDYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5zYXZlLmFmdGVyLmVycm9yJywgZXJyb3IpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaG9va0NhbGxiYWNrKCk7XG4gICAgICAgIH0pO1xuICAgICAgfSxcbiAgICB9O1xuICB9XG5cblxuICBjb25zdCBxdWVyeU9wdGlvbnMgPSB7IHByZXBhcmU6IG9wdGlvbnMucHJlcGFyZSB9O1xuICBpZiAob3B0aW9ucy5jb25zaXN0ZW5jeSkgcXVlcnlPcHRpb25zLmNvbnNpc3RlbmN5ID0gb3B0aW9ucy5jb25zaXN0ZW5jeTtcbiAgaWYgKG9wdGlvbnMuZmV0Y2hTaXplKSBxdWVyeU9wdGlvbnMuZmV0Y2hTaXplID0gb3B0aW9ucy5mZXRjaFNpemU7XG4gIGlmIChvcHRpb25zLmF1dG9QYWdlKSBxdWVyeU9wdGlvbnMuYXV0b1BhZ2UgPSBvcHRpb25zLmF1dG9QYWdlO1xuICBpZiAob3B0aW9ucy5oaW50cykgcXVlcnlPcHRpb25zLmhpbnRzID0gb3B0aW9ucy5oaW50cztcbiAgaWYgKG9wdGlvbnMucGFnZVN0YXRlKSBxdWVyeU9wdGlvbnMucGFnZVN0YXRlID0gb3B0aW9ucy5wYWdlU3RhdGU7XG4gIGlmIChvcHRpb25zLnJldHJ5KSBxdWVyeU9wdGlvbnMucmV0cnkgPSBvcHRpb25zLnJldHJ5O1xuICBpZiAob3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeSkgcXVlcnlPcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5ID0gb3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeTtcblxuICBzY2hlbWEuYmVmb3JlX3NhdmUodGhpcywgb3B0aW9ucywgKGVycm9yKSA9PiB7XG4gICAgaWYgKGVycm9yKSB7XG4gICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuYmVmb3JlLmVycm9yJywgZXJyb3IpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuYmVmb3JlLmVycm9yJywgZXJyb3IpKTtcbiAgICB9XG5cbiAgICB0aGlzLmNvbnN0cnVjdG9yLl9leGVjdXRlX3RhYmxlX3F1ZXJ5KHF1ZXJ5LCBxdWVyeVBhcmFtcywgcXVlcnlPcHRpb25zLCAoZXJyLCByZXN1bHQpID0+IHtcbiAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuZGJlcnJvcicsIGVycikpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIW9wdGlvbnMuaWZfbm90X2V4aXN0IHx8IChyZXN1bHQucm93cyAmJiByZXN1bHQucm93c1swXSAmJiByZXN1bHQucm93c1swXVsnW2FwcGxpZWRdJ10pKSB7XG4gICAgICAgICAgdGhpcy5fbW9kaWZpZWQgPSB7fTtcbiAgICAgICAgfVxuICAgICAgICBzY2hlbWEuYWZ0ZXJfc2F2ZSh0aGlzLCBvcHRpb25zLCAoZXJyb3IxKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yMSkge1xuICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5hZnRlci5lcnJvcicsIGVycm9yMSkpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjYWxsYmFjayhudWxsLCByZXN1bHQpO1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSBpZiAoZXJyKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5zYXZlLmRiZXJyb3InLCBlcnIpKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNjaGVtYS5hZnRlcl9zYXZlKHRoaXMsIG9wdGlvbnMsIChlcnJvcjEpID0+IHtcbiAgICAgICAgICBpZiAoZXJyb3IxKSB7XG4gICAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5hZnRlci5lcnJvcicsIGVycm9yMSkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xuXG4gIHJldHVybiB7fTtcbn07XG5cblxuXG4vKipcbiAqIEltcGxpY2l0IHtyZXR1cm5fcXVlcnk6IHRydWV9IGluIG9wdGlvbnMuXG4gKiBObyBjaGVja3MgLSBqdXN0IHByb2R1Y2VzIHJhdyB7cXVlcnkscGFyYW1zfSByZWNvcmRcbiAqL1xuQmFzZU1vZGVsLnByb3RvdHlwZS5wcmVwYXJlX2JhdGNoX2luc2VydF9mYXN0ID0gZnVuY3Rpb24gZm4ob3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDEgJiYgdHlwZW9mIG9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3QgaWRlbnRpZmllcnMgPSBbXTtcbiAgY29uc3QgdmFsdWVzID0gW107XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLmNvbnN0cnVjdG9yLl9wcm9wZXJ0aWVzO1xuICBjb25zdCBzY2hlbWEgPSBwcm9wZXJ0aWVzLnNjaGVtYTtcblxuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgY29uc3QgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBsZXQgc2NoZW1hRmllbGRLZXlzID0gT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcyk7XG4gIGZvciAobGV0IGkgPSAwLCBqID0gc2NoZW1hRmllbGRLZXlzLmxlbmd0aDsgaSA8IGo7IGkrKykge1xuICAgIGxldCBmID0gc2NoZW1hRmllbGRLZXlzW2ldO1xuXG4gICAgaWYgKHNjaGVtYS5maWVsZHNbZl0udmlydHVhbCkgY29udGludWU7XG5cbiAgICBsZXQgZmllbGR2YWx1ZSA9IHRoaXNbZl07XG4gICAgaWYgKGZpZWxkdmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZmllbGR2YWx1ZSA9IHRoaXMuX2dldF9kZWZhdWx0X3ZhbHVlKGYpO1xuICAgIH1cbiAgICBpZiAoZmllbGR2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZGVudGlmaWVycy5wdXNoKHV0aWwuZm9ybWF0KCdcIiVzXCInLCBmKSk7XG5cbiAgICB2YXIgZGJWYWwgPSB0aGlzLmNvbnN0cnVjdG9yLl9nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihmLCBmaWVsZHZhbHVlKTtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGRiVmFsKSAmJiBkYlZhbC5xdWVyeV9zZWdtZW50KSB7XG4gICAgICB2YWx1ZXMucHVzaChkYlZhbC5xdWVyeV9zZWdtZW50KTtcbiAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdmFsdWVzLnB1c2goZGJWYWwpO1xuICAgIH1cblxuICB9XG5cbiAgbGV0IHF1ZXJ5ID0gdXRpbC5mb3JtYXQoXG4gICAgJ0lOU0VSVCBJTlRPIFwiJXNcIiAoICVzICkgVkFMVUVTICggJXMgKScsXG4gICAgcHJvcGVydGllcy50YWJsZV9uYW1lLFxuICAgIGlkZW50aWZpZXJzLmpvaW4oJyAsICcpLFxuICAgIHZhbHVlcy5qb2luKCcgLCAnKSxcbiAgKTtcblxuICBpZiAob3B0aW9ucy5pZl9ub3RfZXhpc3QpIHF1ZXJ5ICs9ICcgSUYgTk9UIEVYSVNUUyc7XG4gIGlmIChvcHRpb25zLnR0bCkgcXVlcnkgKz0gdXRpbC5mb3JtYXQoJyBVU0lORyBUVEwgJXMnLCBvcHRpb25zLnR0bCk7XG5cbiAgcXVlcnkgKz0gJzsnO1xuXG4gIHJldHVybiB7XG4gICAgcXVlcnksXG4gICAgcGFyYW1zOiBxdWVyeVBhcmFtc1xuICB9O1xufVxuXG5CYXNlTW9kZWwucHJvdG90eXBlLmRlbGV0ZSA9IGZ1bmN0aW9uIGYob3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDEgJiYgdHlwZW9mIG9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3Qgc2NoZW1hID0gdGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcy5zY2hlbWE7XG4gIGNvbnN0IGRlbGV0ZVF1ZXJ5ID0ge307XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBzY2hlbWEua2V5Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgZmllbGRLZXkgPSBzY2hlbWEua2V5W2ldO1xuICAgIGlmIChmaWVsZEtleSBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgICBmb3IgKGxldCBqID0gMDsgaiA8IGZpZWxkS2V5Lmxlbmd0aDsgaisrKSB7XG4gICAgICAgIGRlbGV0ZVF1ZXJ5W2ZpZWxkS2V5W2pdXSA9IHRoaXNbZmllbGRLZXlbal1dO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBkZWxldGVRdWVyeVtmaWVsZEtleV0gPSB0aGlzW2ZpZWxkS2V5XTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gdGhpcy5jb25zdHJ1Y3Rvci5kZWxldGUoZGVsZXRlUXVlcnksIG9wdGlvbnMsIGNhbGxiYWNrKTtcbn07XG5cbkJhc2VNb2RlbC5wcm90b3R5cGUudG9KU09OID0gZnVuY3Rpb24gdG9KU09OKCkge1xuICBjb25zdCBvYmplY3QgPSB7fTtcbiAgY29uc3Qgc2NoZW1hID0gdGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcy5zY2hlbWE7XG5cbiAgT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuZm9yRWFjaCgoZmllbGQpID0+IHtcbiAgICBvYmplY3RbZmllbGRdID0gdGhpc1tmaWVsZF07XG4gIH0pO1xuXG4gIHJldHVybiBvYmplY3Q7XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLmlzTW9kaWZpZWQgPSBmdW5jdGlvbiBpc01vZGlmaWVkKHByb3BOYW1lKSB7XG4gIGlmIChwcm9wTmFtZSkge1xuICAgIHJldHVybiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwodGhpcy5fbW9kaWZpZWQsIHByb3BOYW1lKTtcbiAgfVxuICByZXR1cm4gT2JqZWN0LmtleXModGhpcy5fbW9kaWZpZWQpLmxlbmd0aCAhPT0gMDtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gQmFzZU1vZGVsOyJdfQ==