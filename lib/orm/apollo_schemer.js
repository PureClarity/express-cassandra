'use strict';

var TYPE_MAP = require('./cassandra_types');
var _ = require('lodash');
var util = require('util');

var schemer = {
  normalize_model_schema: function normalize_model_schema(modelSchema) {
    var outputSchema = _.cloneDeep(modelSchema, true);
    var goodFields = {
      fields: true,
      key: true,
      clustering_order: true,
      materialized_views: true,
      indexes: true,
      custom_index: true,
      custom_indexes: true
    };

    Object.keys(outputSchema).forEach(function (k) {
      if (!(k in goodFields)) delete outputSchema[k];
    });

    Object.keys(outputSchema.fields).forEach(function (k) {
      if (typeof outputSchema.fields[k] === 'string') {
        outputSchema.fields[k] = { type: outputSchema.fields[k] };
      } else if (outputSchema.fields[k]) {
        if (outputSchema.fields[k].virtual) {
          delete outputSchema.fields[k];
        } else if (outputSchema.fields[k].typeDef) {
          outputSchema.fields[k] = { type: outputSchema.fields[k].type, typeDef: outputSchema.fields[k].typeDef };
        } else {
          outputSchema.fields[k] = { type: outputSchema.fields[k].type };
        }
      } else {
        throw new Error(util.format('schema field "%s" is not properly defined: %s', k, outputSchema.fields[k]));
      }

      if (k === 'solr_query') {
        delete outputSchema.fields[k];
      }

      if (outputSchema.fields[k] && outputSchema.fields[k].type === 'varchar') {
        outputSchema.fields[k].type = 'text';
      }

      if (outputSchema.fields[k] && ['map', 'list', 'set', 'frozen'].indexOf(outputSchema.fields[k].type) > -1) {
        if (modelSchema.typeMaps && modelSchema.typeMaps[k]) {
          outputSchema.fields[k].typeDef = modelSchema.typeMaps[k];
        } else {
          // eslint-disable-next-line max-len
          outputSchema.fields[k].typeDef = outputSchema.fields[k].typeDef.replace(/[\s]/g, '').replace(/varchar/g, 'text');
        }
      }

      if (outputSchema.fields[k]) {
        if (modelSchema.staticMaps && modelSchema.staticMaps[k] === true) {
          outputSchema.fields[k].static = true;
        } else if (modelSchema.fields[k].static) {
          outputSchema.fields[k].static = true;
        }
      }
    });

    if (outputSchema.key && typeof outputSchema.key[0] === 'string') {
      outputSchema.key[0] = [outputSchema.key[0]];
    }

    if (outputSchema.key && outputSchema.key.length) {
      for (var i = 1; i < outputSchema.key.length; i++) {
        if (!outputSchema.clustering_order) outputSchema.clustering_order = {};
        if (!outputSchema.clustering_order[outputSchema.key[i]]) {
          outputSchema.clustering_order[outputSchema.key[i]] = 'ASC';
        }

        // eslint-disable-next-line max-len
        outputSchema.clustering_order[outputSchema.key[i]] = outputSchema.clustering_order[outputSchema.key[i]].toUpperCase();
      }
    }

    var arraySort = function arraySort(a, b) {
      if (a > b) return 1;
      if (a < b) return -1;
      return 0;
    };

    if (outputSchema.materialized_views) {
      Object.keys(outputSchema.materialized_views).forEach(function (mvindex) {
        var outputMView = outputSchema.materialized_views[mvindex];
        // make parition key an array
        if (outputMView.key && typeof outputMView.key[0] === 'string') {
          outputMView.key[0] = [outputMView.key[0]];
        }

        // add clustering_order for all clustering keys
        if (outputMView.key && outputMView.key.length) {
          for (var _i = 1; _i < outputMView.key.length; _i++) {
            if (!outputMView.clustering_order) {
              outputMView.clustering_order = {};
            }
            if (!outputMView.clustering_order[outputMView.key[_i]]) {
              outputMView.clustering_order[outputMView.key[_i]] = 'ASC';
            }
            // eslint-disable-next-line max-len
            outputMView.clustering_order[outputMView.key[_i]] = outputMView.clustering_order[outputMView.key[_i]].toUpperCase();
          }
        }

        // add all non existent primary key items to select and sort them
        for (var pkeyIndex = 0; pkeyIndex < outputMView.key.length; pkeyIndex++) {
          if (pkeyIndex === 0) {
            for (var partitionIndex = 0; partitionIndex < outputMView.key[pkeyIndex].length; partitionIndex++) {
              if (outputMView.select.indexOf(outputMView.key[pkeyIndex][partitionIndex]) === -1) {
                outputMView.select.push(outputMView.key[pkeyIndex][partitionIndex]);
              }
            }
          } else if (outputMView.select.indexOf(outputMView.key[pkeyIndex]) === -1) {
            outputMView.select.push(outputMView.key[pkeyIndex]);
          }
        }

        // check if select has * and then add all fields to select
        if (outputMView.select[0] === '*') {
          outputMView.select = Object.keys(outputSchema.fields);
        }

        outputMView.select.sort(arraySort);
      });
    } else {
      outputSchema.materialized_views = {};
    }

    if (outputSchema.indexes) {
      for (var _i2 = 0; _i2 < outputSchema.indexes.length; _i2++) {
        var indexNameList = outputSchema.indexes[_i2].replace(/["\s]/g, '').split(/[()]/g);
        if (indexNameList.length > 1) {
          indexNameList[0] = indexNameList[0].toLowerCase();
          if (indexNameList[0] === 'values') outputSchema.indexes[_i2] = indexNameList[1];else outputSchema.indexes[_i2] = util.format('%s(%s)', indexNameList[0], indexNameList[1]);
        } else {
          outputSchema.indexes[_i2] = indexNameList[0];
        }
      }
      outputSchema.indexes.sort(arraySort);
    } else {
      outputSchema.indexes = [];
    }

    if (outputSchema.custom_index) {
      outputSchema.custom_indexes = [outputSchema.custom_index];
      delete outputSchema.custom_index;
    }

    if (outputSchema.custom_indexes) {
      var customArraySort = function customArraySort(a, b) {
        if (a.on > b.on) return 1;
        if (a.on < b.on) return -1;

        if (a.using > b.using) return 1;
        if (a.using < b.using) return -1;

        if (a.options > b.options) return 1;
        if (a.options < b.options) return -1;

        return 0;
      };

      outputSchema.custom_indexes.sort(customArraySort);
    } else {
      outputSchema.custom_indexes = [];
    }

    outputSchema.custom_indexes = _.remove(outputSchema.custom_indexes, function (cindex) {
      return cindex.on !== 'solr_query';
    });

    return outputSchema;
  },
  validate_model_schema: function validate_model_schema(modelSchema) {
    var _this = this;

    if (!modelSchema) throw new Error('A schema must be specified');

    if (!_.isPlainObject(modelSchema.fields) || Object.keys(modelSchema.fields).length === 0) {
      throw new Error('Schema must contain a non-empty "fields" map object');
    }

    if (!modelSchema.key || !(modelSchema.key instanceof Array)) {
      throw new Error('Schema must contain "key" in the form: [ [partitionkey1, ...], clusteringkey1, ...]');
    }

    Object.keys(modelSchema.fields).forEach(function (k) {
      var fieldtype = _this.get_field_type(modelSchema, k);
      if (!(fieldtype in TYPE_MAP)) {
        throw new Error(util.format('Given schema field type is not supported for: %s(%s)', k, modelSchema.fields[k].type));
      }
      if (!_this.is_field_default_value_valid(modelSchema, k)) {
        throw new Error(util.format('Invalid defult definition for: %s(%s)', k, modelSchema.fields[k].type));
      }
    });

    // validate primary key
    if (typeof modelSchema.key[0] === 'string') {
      if (!(modelSchema.key[0] in modelSchema.fields)) {
        throw new Error('Partition Key must also be a valid field name');
      }
      if (modelSchema.fields[modelSchema.key[0]].virtual) {
        throw new Error("Partition Key must also be a db field name, can't be a virtual field name");
      }
    } else if (modelSchema.key[0] instanceof Array) {
      if (modelSchema.key[0].length === 0) {
        throw new Error("Partition Key array can't be empty");
      }
      for (var j = 0; j < modelSchema.key[0].length; j++) {
        if (typeof modelSchema.key[0][j] !== 'string' || !(modelSchema.key[0][j] in modelSchema.fields)) {
          throw new Error('Partition Key array must contain only valid field names');
        }
        if (modelSchema.fields[modelSchema.key[0][j]].virtual) {
          throw new Error("Partition Key array must contain only db field names, can't contain virtual field names");
        }
      }
    } else {
      throw new Error('Partition Key must be a field name string, or array of field names');
    }

    for (var i = 0; i < modelSchema.key.length; i++) {
      if (i > 0) {
        if (typeof modelSchema.key[i] !== 'string' || !(modelSchema.key[i] in modelSchema.fields)) {
          throw new Error('Clustering Keys must be valid field names');
        }
        if (modelSchema.fields[modelSchema.key[i]].virtual) {
          throw new Error("Clustering Keys must be db field names, can't be virtual field names");
        }
      }
    }

    if (modelSchema.clustering_order) {
      if (!_.isPlainObject(modelSchema.clustering_order)) {
        throw new Error('clustering_order must be an object of clustering_key attributes');
      }

      Object.keys(modelSchema.clustering_order).forEach(function (cindex) {
        if (['asc', 'desc'].indexOf(modelSchema.clustering_order[cindex].toLowerCase()) === -1) {
          throw new Error('clustering_order attribute values can only be ASC or DESC');
        }
        if (modelSchema.key.indexOf(cindex) < 1) {
          throw new Error('clustering_order field attributes must be clustering keys only');
        }
      });
    }

    // validate materialized_view
    if (modelSchema.materialized_views) {
      if (!_.isPlainObject(modelSchema.materialized_views)) {
        throw new Error('materialized_views must be an object with view names as attributes');
      }

      Object.keys(modelSchema.materialized_views).forEach(function (mvindex) {
        var candidateMView = modelSchema.materialized_views[mvindex];
        if (!_.isPlainObject(candidateMView)) {
          throw new Error(util.format('attribute "%s" under materialized_views must be an object', mvindex));
        }

        if (!candidateMView.select || !candidateMView.key) {
          throw new Error(util.format('materialized_view "%s" must have "select" and "key" attributes', mvindex));
        }

        if (!(candidateMView.select instanceof Array) || !(candidateMView.key instanceof Array)) {
          throw new Error(util.format('"select" and "key" attributes must be an array under attribute %s of materialized_views', mvindex));
        }

        for (var selectindex = 0; selectindex < candidateMView.select.length; selectindex++) {
          if (typeof candidateMView.select[selectindex] !== 'string' || !(candidateMView.select[selectindex] in modelSchema.fields || candidateMView.select[selectindex] === '*')) {
            throw new Error(util.format('the select attribute under materialized_view %s must be an array of field name strings or ["*"]', mvindex));
          }

          if (modelSchema.fields[candidateMView.select[selectindex]] && modelSchema.fields[candidateMView.select[selectindex]].virtual) {
            throw new Error(util.format('the select attribute under %s of materialized_views must be an array of db field names, ' + 'cannot contain any virtual field name', mvindex));
          }
        }

        // validate materialized_view primary key
        if (typeof candidateMView.key[0] === 'string') {
          if (!(candidateMView.key[0] in modelSchema.fields)) {
            throw new Error(util.format('materialized_view %s: partition key string must match a valid field name', mvindex));
          }
          if (modelSchema.fields[candidateMView.key[0]].virtual) {
            throw new Error(util.format('materialized_view %s: partition key must match a db field name, cannot be a virtual field name', mvindex));
          }
        } else if (candidateMView.key[0] instanceof Array) {
          if (candidateMView.key[0].length === 0) {
            throw new Error(util.format('materialized_view %s: partition key array cannot be empty', mvindex));
          }
          for (var _j = 0; _j < candidateMView.key[0].length; _j++) {
            if (typeof candidateMView.key[0][_j] !== 'string' || !(candidateMView.key[0][_j] in modelSchema.fields)) {
              throw new Error(util.format('materialized_view %s: partition key array must contain only valid field names', mvindex));
            }
            if (modelSchema.fields[candidateMView.key[0][_j]].virtual) {
              throw new Error(util.format('materialized_view %s: partition key array must contain only db field names, ' + 'cannot contain virtual field names', mvindex));
            }
          }
        } else {
          throw new Error(util.format('materialized_view %s: partition key must be a field name string, or array of field names', mvindex));
        }

        for (var _i3 = 0; _i3 < candidateMView.key.length; _i3++) {
          if (_i3 > 0) {
            if (typeof candidateMView.key[_i3] !== 'string' || !(candidateMView.key[_i3] in modelSchema.fields)) {
              throw new Error(util.format('materialized_view %s: clustering keys must be valid field names', mvindex));
            }
            if (modelSchema.fields[candidateMView.key[_i3]].virtual) {
              throw new Error(util.format('materialized_view %s: clustering keys must be db field names, cannot contain virtual fields', mvindex));
            }
          }
        }

        if (candidateMView.clustering_order) {
          if (!_.isPlainObject(candidateMView.clustering_order)) {
            throw new Error(util.format('materialized_view %s: clustering_order must be an object of clustering_key attributes', mvindex));
          }

          Object.keys(candidateMView.clustering_order).forEach(function (cindex) {
            if (['asc', 'desc'].indexOf(candidateMView.clustering_order[cindex].toLowerCase()) === -1) {
              throw new Error(util.format('materialized_view %s: clustering_order attribute values can only be ASC or DESC', mvindex));
            }
            if (candidateMView.key.indexOf(cindex) < 1) {
              throw new Error(util.format('materialized_view %s: clustering_order field attributes must be clustering keys only', mvindex));
            }
          });
        }
      });
    }

    // validate indexes
    if (modelSchema.indexes) {
      if (!(modelSchema.indexes instanceof Array)) {
        throw new Error('indexes must be an array of field name strings');
      }

      for (var l = 0; l < modelSchema.indexes.length; l++) {
        if (typeof modelSchema.indexes[l] !== 'string') {
          throw new Error('indexes must be an array of strings');
        }

        var indexNameList = modelSchema.indexes[l].replace(/["\s]/g, '').split(/[()]/g);
        if (indexNameList.length > 1) {
          indexNameList[0] = indexNameList[0].toLowerCase();
          if (['entries', 'keys', 'values', 'full'].indexOf(indexNameList[0]) < 0) {
            throw new Error(util.format('index "%s" is not defined properly', modelSchema.indexes[l]));
          }
          if (!(indexNameList[1] in modelSchema.fields)) {
            throw new Error(util.format('"%s" is not a valid field name, indexes must be defined on field names', indexNameList[1]));
          }
          if (modelSchema.fields[indexNameList[1]].virtual) {
            throw new Error("indexes must be an array of db field names, can't contain virtual fields");
          }
        } else {
          if (!(indexNameList[0] in modelSchema.fields)) {
            throw new Error(util.format('"%s" is not a valid field, indexes must be defined on field names', indexNameList[0]));
          }
          if (modelSchema.fields[indexNameList[0]].virtual) {
            throw new Error("indexes must be an array of db field names, can't contain virtual fields");
          }
        }
      }
    }

    var validateCustomIndex = function validateCustomIndex(customIndex) {
      if (!_.isPlainObject(customIndex)) {
        throw new Error('custom_index must be an object with proper indexing attributes');
      }
      if (typeof customIndex.on !== 'string' || !(customIndex.on in modelSchema.fields)) {
        throw new Error("custom_index must have an 'on' attribute with string value and value must be a valid field name");
      }
      if (modelSchema.fields[customIndex.on].virtual) {
        throw new Error("custom_index 'on' attribute must be a db field name, can't contain virtual fields");
      }
      if (typeof customIndex.using !== 'string') {
        throw new Error("custom_index must have a 'using' attribute with string value");
      }
      if (!_.isPlainObject(customIndex.options)) {
        throw new Error('custom_index must have an "options" attribute and it must be an object, ' + 'pass blank {} object if no options are required');
      }
    };

    if (modelSchema.custom_index && modelSchema.custom_indexes) {
      throw new Error('both custom_index and custom_indexes are defined in schema, only one of them should be defined');
    }

    if (modelSchema.custom_index) {
      validateCustomIndex(modelSchema.custom_index);
    }

    if (modelSchema.custom_indexes) {
      if (modelSchema.custom_indexes instanceof Array) {
        for (var ci = 0; ci < modelSchema.custom_indexes.length; ci++) {
          validateCustomIndex(modelSchema.custom_indexes[ci]);
        }
      } else {
        throw new Error('custom_indexes must be an array with objects with proper indexing attributes');
      }
    }
  },
  get_field_type: function get_field_type(modelSchema, fieldname) {
    var fieldob = modelSchema.fields[fieldname];

    if (typeof fieldob === 'string') return fieldob;else if (_.isPlainObject(fieldob)) return fieldob.type;
    throw new Error(util.format('Field type not defined for field "%s"', fieldname));
  },
  is_field_default_value_valid: function is_field_default_value_valid(modelSchema, fieldname) {
    if (_.isPlainObject(modelSchema.fields[fieldname]) && modelSchema.fields[fieldname].default) {
      if (_.isPlainObject(modelSchema.fields[fieldname].default) && !modelSchema.fields[fieldname].default.$db_function) {
        if (['map', 'list', 'set', 'frozen'].indexOf(modelSchema.fields[fieldname].type) > -1) return true;
        return false;
      }
      return true;
    }
    return true;
  }
};

module.exports = schemer;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9vcm0vYXBvbGxvX3NjaGVtZXIuanMiXSwibmFtZXMiOlsiVFlQRV9NQVAiLCJyZXF1aXJlIiwiXyIsInV0aWwiLCJzY2hlbWVyIiwibm9ybWFsaXplX21vZGVsX3NjaGVtYSIsIm1vZGVsU2NoZW1hIiwib3V0cHV0U2NoZW1hIiwiY2xvbmVEZWVwIiwiZ29vZEZpZWxkcyIsImZpZWxkcyIsImtleSIsImNsdXN0ZXJpbmdfb3JkZXIiLCJtYXRlcmlhbGl6ZWRfdmlld3MiLCJpbmRleGVzIiwiY3VzdG9tX2luZGV4IiwiY3VzdG9tX2luZGV4ZXMiLCJPYmplY3QiLCJrZXlzIiwiZm9yRWFjaCIsImsiLCJ0eXBlIiwidmlydHVhbCIsInR5cGVEZWYiLCJFcnJvciIsImZvcm1hdCIsImluZGV4T2YiLCJ0eXBlTWFwcyIsInJlcGxhY2UiLCJzdGF0aWNNYXBzIiwic3RhdGljIiwibGVuZ3RoIiwiaSIsInRvVXBwZXJDYXNlIiwiYXJyYXlTb3J0IiwiYSIsImIiLCJtdmluZGV4Iiwib3V0cHV0TVZpZXciLCJwa2V5SW5kZXgiLCJwYXJ0aXRpb25JbmRleCIsInNlbGVjdCIsInB1c2giLCJzb3J0IiwiaW5kZXhOYW1lTGlzdCIsInNwbGl0IiwidG9Mb3dlckNhc2UiLCJjdXN0b21BcnJheVNvcnQiLCJvbiIsInVzaW5nIiwib3B0aW9ucyIsInJlbW92ZSIsImNpbmRleCIsInZhbGlkYXRlX21vZGVsX3NjaGVtYSIsImlzUGxhaW5PYmplY3QiLCJBcnJheSIsImZpZWxkdHlwZSIsImdldF9maWVsZF90eXBlIiwiaXNfZmllbGRfZGVmYXVsdF92YWx1ZV92YWxpZCIsImoiLCJjYW5kaWRhdGVNVmlldyIsInNlbGVjdGluZGV4IiwibCIsInZhbGlkYXRlQ3VzdG9tSW5kZXgiLCJjdXN0b21JbmRleCIsImNpIiwiZmllbGRuYW1lIiwiZmllbGRvYiIsImRlZmF1bHQiLCIkZGJfZnVuY3Rpb24iLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoi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c291cmNlc0NvbnRlbnQiOlsiY29uc3QgVFlQRV9NQVAgPSByZXF1aXJlKCcuL2Nhc3NhbmRyYV90eXBlcycpO1xuY29uc3QgXyA9IHJlcXVpcmUoJ2xvZGFzaCcpO1xuY29uc3QgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcblxuY29uc3Qgc2NoZW1lciA9IHtcblxuICBub3JtYWxpemVfbW9kZWxfc2NoZW1hKG1vZGVsU2NoZW1hKSB7XG4gICAgY29uc3Qgb3V0cHV0U2NoZW1hID0gXy5jbG9uZURlZXAobW9kZWxTY2hlbWEsIHRydWUpO1xuICAgIGNvbnN0IGdvb2RGaWVsZHMgPSB7XG4gICAgICBmaWVsZHM6IHRydWUsXG4gICAgICBrZXk6IHRydWUsXG4gICAgICBjbHVzdGVyaW5nX29yZGVyOiB0cnVlLFxuICAgICAgbWF0ZXJpYWxpemVkX3ZpZXdzOiB0cnVlLFxuICAgICAgaW5kZXhlczogdHJ1ZSxcbiAgICAgIGN1c3RvbV9pbmRleDogdHJ1ZSxcbiAgICAgIGN1c3RvbV9pbmRleGVzOiB0cnVlLFxuICAgIH07XG5cbiAgICBPYmplY3Qua2V5cyhvdXRwdXRTY2hlbWEpLmZvckVhY2goKGspID0+IHtcbiAgICAgIGlmICghKGsgaW4gZ29vZEZpZWxkcykpIGRlbGV0ZSAob3V0cHV0U2NoZW1hW2tdKTtcbiAgICB9KTtcblxuICAgIE9iamVjdC5rZXlzKG91dHB1dFNjaGVtYS5maWVsZHMpLmZvckVhY2goKGspID0+IHtcbiAgICAgIGlmICh0eXBlb2YgKG91dHB1dFNjaGVtYS5maWVsZHNba10pID09PSAnc3RyaW5nJykge1xuICAgICAgICBvdXRwdXRTY2hlbWEuZmllbGRzW2tdID0geyB0eXBlOiBvdXRwdXRTY2hlbWEuZmllbGRzW2tdIH07XG4gICAgICB9IGVsc2UgaWYgKG91dHB1dFNjaGVtYS5maWVsZHNba10pIHtcbiAgICAgICAgaWYgKG91dHB1dFNjaGVtYS5maWVsZHNba10udmlydHVhbCkge1xuICAgICAgICAgIGRlbGV0ZSBvdXRwdXRTY2hlbWEuZmllbGRzW2tdO1xuICAgICAgICB9IGVsc2UgaWYgKG91dHB1dFNjaGVtYS5maWVsZHNba10udHlwZURlZikge1xuICAgICAgICAgIG91dHB1dFNjaGVtYS5maWVsZHNba10gPSB7IHR5cGU6IG91dHB1dFNjaGVtYS5maWVsZHNba10udHlwZSwgdHlwZURlZjogb3V0cHV0U2NoZW1hLmZpZWxkc1trXS50eXBlRGVmIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgb3V0cHV0U2NoZW1hLmZpZWxkc1trXSA9IHsgdHlwZTogb3V0cHV0U2NoZW1hLmZpZWxkc1trXS50eXBlIH07XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IChuZXcgRXJyb3IoXG4gICAgICAgICAgdXRpbC5mb3JtYXQoJ3NjaGVtYSBmaWVsZCBcIiVzXCIgaXMgbm90IHByb3Blcmx5IGRlZmluZWQ6ICVzJywgaywgb3V0cHV0U2NoZW1hLmZpZWxkc1trXSksXG4gICAgICAgICkpO1xuICAgICAgfVxuXG4gICAgICBpZiAoayA9PT0gJ3NvbHJfcXVlcnknKSB7XG4gICAgICAgIGRlbGV0ZSBvdXRwdXRTY2hlbWEuZmllbGRzW2tdO1xuICAgICAgfVxuXG4gICAgICBpZiAob3V0cHV0U2NoZW1hLmZpZWxkc1trXSAmJiBvdXRwdXRTY2hlbWEuZmllbGRzW2tdLnR5cGUgPT09ICd2YXJjaGFyJykge1xuICAgICAgICBvdXRwdXRTY2hlbWEuZmllbGRzW2tdLnR5cGUgPSAndGV4dCc7XG4gICAgICB9XG5cbiAgICAgIGlmIChvdXRwdXRTY2hlbWEuZmllbGRzW2tdICYmIFsnbWFwJywgJ2xpc3QnLCAnc2V0JywgJ2Zyb3plbiddLmluZGV4T2Yob3V0cHV0U2NoZW1hLmZpZWxkc1trXS50eXBlKSA+IC0xKSB7XG4gICAgICAgIGlmIChtb2RlbFNjaGVtYS50eXBlTWFwcyAmJiBtb2RlbFNjaGVtYS50eXBlTWFwc1trXSkge1xuICAgICAgICAgIG91dHB1dFNjaGVtYS5maWVsZHNba10udHlwZURlZiA9IG1vZGVsU2NoZW1hLnR5cGVNYXBzW2tdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBtYXgtbGVuXG4gICAgICAgICAgb3V0cHV0U2NoZW1hLmZpZWxkc1trXS50eXBlRGVmID0gb3V0cHV0U2NoZW1hLmZpZWxkc1trXS50eXBlRGVmLnJlcGxhY2UoL1tcXHNdL2csICcnKS5yZXBsYWNlKC92YXJjaGFyL2csICd0ZXh0Jyk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKG91dHB1dFNjaGVtYS5maWVsZHNba10pIHtcbiAgICAgICAgaWYgKG1vZGVsU2NoZW1hLnN0YXRpY01hcHMgJiYgbW9kZWxTY2hlbWEuc3RhdGljTWFwc1trXSA9PT0gdHJ1ZSkge1xuICAgICAgICAgIG91dHB1dFNjaGVtYS5maWVsZHNba10uc3RhdGljID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIGlmIChtb2RlbFNjaGVtYS5maWVsZHNba10uc3RhdGljKSB7XG4gICAgICAgICAgb3V0cHV0U2NoZW1hLmZpZWxkc1trXS5zdGF0aWMgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpZiAob3V0cHV0U2NoZW1hLmtleSAmJiB0eXBlb2Ygb3V0cHV0U2NoZW1hLmtleVswXSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIG91dHB1dFNjaGVtYS5rZXlbMF0gPSBbb3V0cHV0U2NoZW1hLmtleVswXV07XG4gICAgfVxuXG4gICAgaWYgKG91dHB1dFNjaGVtYS5rZXkgJiYgb3V0cHV0U2NoZW1hLmtleS5sZW5ndGgpIHtcbiAgICAgIGZvciAobGV0IGkgPSAxOyBpIDwgb3V0cHV0U2NoZW1hLmtleS5sZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAoIW91dHB1dFNjaGVtYS5jbHVzdGVyaW5nX29yZGVyKSBvdXRwdXRTY2hlbWEuY2x1c3RlcmluZ19vcmRlciA9IHt9O1xuICAgICAgICBpZiAoIW91dHB1dFNjaGVtYS5jbHVzdGVyaW5nX29yZGVyW291dHB1dFNjaGVtYS5rZXlbaV1dKSB7XG4gICAgICAgICAgb3V0cHV0U2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbb3V0cHV0U2NoZW1hLmtleVtpXV0gPSAnQVNDJztcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBtYXgtbGVuXG4gICAgICAgIG91dHB1dFNjaGVtYS5jbHVzdGVyaW5nX29yZGVyW291dHB1dFNjaGVtYS5rZXlbaV1dID0gb3V0cHV0U2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbb3V0cHV0U2NoZW1hLmtleVtpXV0udG9VcHBlckNhc2UoKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBhcnJheVNvcnQgPSAoYSwgYikgPT4ge1xuICAgICAgaWYgKGEgPiBiKSByZXR1cm4gMTtcbiAgICAgIGlmIChhIDwgYikgcmV0dXJuIC0xO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfTtcblxuICAgIGlmIChvdXRwdXRTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKSB7XG4gICAgICBPYmplY3Qua2V5cyhvdXRwdXRTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKS5mb3JFYWNoKChtdmluZGV4KSA9PiB7XG4gICAgICAgIGNvbnN0IG91dHB1dE1WaWV3ID0gb3V0cHV0U2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1ttdmluZGV4XTtcbiAgICAgICAgLy8gbWFrZSBwYXJpdGlvbiBrZXkgYW4gYXJyYXlcbiAgICAgICAgaWYgKG91dHB1dE1WaWV3LmtleVxuICAgICAgICAgICAgICAmJiB0eXBlb2Ygb3V0cHV0TVZpZXcua2V5WzBdID09PSAnc3RyaW5nJykge1xuICAgICAgICAgIG91dHB1dE1WaWV3LmtleVswXSA9IFtvdXRwdXRNVmlldy5rZXlbMF1dO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gYWRkIGNsdXN0ZXJpbmdfb3JkZXIgZm9yIGFsbCBjbHVzdGVyaW5nIGtleXNcbiAgICAgICAgaWYgKG91dHB1dE1WaWV3LmtleVxuICAgICAgICAgICAgICAmJiBvdXRwdXRNVmlldy5rZXkubGVuZ3RoKSB7XG4gICAgICAgICAgZm9yIChsZXQgaSA9IDE7IGkgPCBvdXRwdXRNVmlldy5rZXkubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIGlmICghb3V0cHV0TVZpZXcuY2x1c3RlcmluZ19vcmRlcikge1xuICAgICAgICAgICAgICBvdXRwdXRNVmlldy5jbHVzdGVyaW5nX29yZGVyID0ge307XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIW91dHB1dE1WaWV3LmNsdXN0ZXJpbmdfb3JkZXJbb3V0cHV0TVZpZXcua2V5W2ldXSkge1xuICAgICAgICAgICAgICBvdXRwdXRNVmlldy5jbHVzdGVyaW5nX29yZGVyW291dHB1dE1WaWV3LmtleVtpXV0gPSAnQVNDJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBtYXgtbGVuXG4gICAgICAgICAgICBvdXRwdXRNVmlldy5jbHVzdGVyaW5nX29yZGVyW291dHB1dE1WaWV3LmtleVtpXV0gPSBvdXRwdXRNVmlldy5jbHVzdGVyaW5nX29yZGVyW291dHB1dE1WaWV3LmtleVtpXV0udG9VcHBlckNhc2UoKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBhZGQgYWxsIG5vbiBleGlzdGVudCBwcmltYXJ5IGtleSBpdGVtcyB0byBzZWxlY3QgYW5kIHNvcnQgdGhlbVxuICAgICAgICBmb3IgKGxldCBwa2V5SW5kZXggPSAwOyBwa2V5SW5kZXggPCBvdXRwdXRNVmlldy5rZXkubGVuZ3RoOyBwa2V5SW5kZXgrKykge1xuICAgICAgICAgIGlmIChwa2V5SW5kZXggPT09IDApIHtcbiAgICAgICAgICAgIGZvciAobGV0IHBhcnRpdGlvbkluZGV4ID0gMDsgcGFydGl0aW9uSW5kZXggPCBvdXRwdXRNVmlldy5rZXlbcGtleUluZGV4XS5sZW5ndGg7IHBhcnRpdGlvbkluZGV4KyspIHtcbiAgICAgICAgICAgICAgaWYgKG91dHB1dE1WaWV3LnNlbGVjdC5pbmRleE9mKG91dHB1dE1WaWV3LmtleVtwa2V5SW5kZXhdW3BhcnRpdGlvbkluZGV4XSkgPT09IC0xKSB7XG4gICAgICAgICAgICAgICAgb3V0cHV0TVZpZXcuc2VsZWN0LnB1c2gob3V0cHV0TVZpZXcua2V5W3BrZXlJbmRleF1bcGFydGl0aW9uSW5kZXhdKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSBpZiAob3V0cHV0TVZpZXcuc2VsZWN0LmluZGV4T2Yob3V0cHV0TVZpZXcua2V5W3BrZXlJbmRleF0pID09PSAtMSkge1xuICAgICAgICAgICAgb3V0cHV0TVZpZXcuc2VsZWN0LnB1c2gob3V0cHV0TVZpZXcua2V5W3BrZXlJbmRleF0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIGNoZWNrIGlmIHNlbGVjdCBoYXMgKiBhbmQgdGhlbiBhZGQgYWxsIGZpZWxkcyB0byBzZWxlY3RcbiAgICAgICAgaWYgKG91dHB1dE1WaWV3LnNlbGVjdFswXSA9PT0gJyonKSB7XG4gICAgICAgICAgb3V0cHV0TVZpZXcuc2VsZWN0ID0gT2JqZWN0LmtleXMob3V0cHV0U2NoZW1hLmZpZWxkcyk7XG4gICAgICAgIH1cblxuICAgICAgICBvdXRwdXRNVmlldy5zZWxlY3Quc29ydChhcnJheVNvcnQpO1xuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG91dHB1dFNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MgPSB7fTtcbiAgICB9XG5cbiAgICBpZiAob3V0cHV0U2NoZW1hLmluZGV4ZXMpIHtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgb3V0cHV0U2NoZW1hLmluZGV4ZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY29uc3QgaW5kZXhOYW1lTGlzdCA9IG91dHB1dFNjaGVtYS5pbmRleGVzW2ldLnJlcGxhY2UoL1tcIlxcc10vZywgJycpLnNwbGl0KC9bKCldL2cpO1xuICAgICAgICBpZiAoaW5kZXhOYW1lTGlzdC5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgaW5kZXhOYW1lTGlzdFswXSA9IGluZGV4TmFtZUxpc3RbMF0udG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICBpZiAoaW5kZXhOYW1lTGlzdFswXSA9PT0gJ3ZhbHVlcycpIG91dHB1dFNjaGVtYS5pbmRleGVzW2ldID0gaW5kZXhOYW1lTGlzdFsxXTtcbiAgICAgICAgICBlbHNlIG91dHB1dFNjaGVtYS5pbmRleGVzW2ldID0gdXRpbC5mb3JtYXQoJyVzKCVzKScsIGluZGV4TmFtZUxpc3RbMF0sIGluZGV4TmFtZUxpc3RbMV0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG91dHB1dFNjaGVtYS5pbmRleGVzW2ldID0gaW5kZXhOYW1lTGlzdFswXTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgb3V0cHV0U2NoZW1hLmluZGV4ZXMuc29ydChhcnJheVNvcnQpO1xuICAgIH0gZWxzZSB7XG4gICAgICBvdXRwdXRTY2hlbWEuaW5kZXhlcyA9IFtdO1xuICAgIH1cblxuICAgIGlmIChvdXRwdXRTY2hlbWEuY3VzdG9tX2luZGV4KSB7XG4gICAgICBvdXRwdXRTY2hlbWEuY3VzdG9tX2luZGV4ZXMgPSBbb3V0cHV0U2NoZW1hLmN1c3RvbV9pbmRleF07XG4gICAgICBkZWxldGUgb3V0cHV0U2NoZW1hLmN1c3RvbV9pbmRleDtcbiAgICB9XG5cbiAgICBpZiAob3V0cHV0U2NoZW1hLmN1c3RvbV9pbmRleGVzKSB7XG4gICAgICBjb25zdCBjdXN0b21BcnJheVNvcnQgPSAoYSwgYikgPT4ge1xuICAgICAgICBpZiAoYS5vbiA+IGIub24pIHJldHVybiAxO1xuICAgICAgICBpZiAoYS5vbiA8IGIub24pIHJldHVybiAtMTtcblxuICAgICAgICBpZiAoYS51c2luZyA+IGIudXNpbmcpIHJldHVybiAxO1xuICAgICAgICBpZiAoYS51c2luZyA8IGIudXNpbmcpIHJldHVybiAtMTtcblxuICAgICAgICBpZiAoYS5vcHRpb25zID4gYi5vcHRpb25zKSByZXR1cm4gMTtcbiAgICAgICAgaWYgKGEub3B0aW9ucyA8IGIub3B0aW9ucykgcmV0dXJuIC0xO1xuXG4gICAgICAgIHJldHVybiAwO1xuICAgICAgfTtcblxuICAgICAgb3V0cHV0U2NoZW1hLmN1c3RvbV9pbmRleGVzLnNvcnQoY3VzdG9tQXJyYXlTb3J0KTtcbiAgICB9IGVsc2Uge1xuICAgICAgb3V0cHV0U2NoZW1hLmN1c3RvbV9pbmRleGVzID0gW107XG4gICAgfVxuXG4gICAgb3V0cHV0U2NoZW1hLmN1c3RvbV9pbmRleGVzID0gXy5yZW1vdmUob3V0cHV0U2NoZW1hLmN1c3RvbV9pbmRleGVzLCAoY2luZGV4KSA9PiAoY2luZGV4Lm9uICE9PSAnc29scl9xdWVyeScpKTtcblxuICAgIHJldHVybiBvdXRwdXRTY2hlbWE7XG4gIH0sXG5cbiAgdmFsaWRhdGVfbW9kZWxfc2NoZW1hKG1vZGVsU2NoZW1hKSB7XG4gICAgaWYgKCFtb2RlbFNjaGVtYSkgdGhyb3cgKG5ldyBFcnJvcignQSBzY2hlbWEgbXVzdCBiZSBzcGVjaWZpZWQnKSk7XG5cbiAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChtb2RlbFNjaGVtYS5maWVsZHMpIHx8IE9iamVjdC5rZXlzKG1vZGVsU2NoZW1hLmZpZWxkcykubGVuZ3RoID09PSAwKSB7XG4gICAgICB0aHJvdyAobmV3IEVycm9yKCdTY2hlbWEgbXVzdCBjb250YWluIGEgbm9uLWVtcHR5IFwiZmllbGRzXCIgbWFwIG9iamVjdCcpKTtcbiAgICB9XG5cbiAgICBpZiAoIW1vZGVsU2NoZW1hLmtleSB8fCAhKG1vZGVsU2NoZW1hLmtleSBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcignU2NoZW1hIG11c3QgY29udGFpbiBcImtleVwiIGluIHRoZSBmb3JtOiBbIFtwYXJ0aXRpb25rZXkxLCAuLi5dLCBjbHVzdGVyaW5na2V5MSwgLi4uXScpKTtcbiAgICB9XG5cbiAgICBPYmplY3Qua2V5cyhtb2RlbFNjaGVtYS5maWVsZHMpLmZvckVhY2goKGspID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkdHlwZSA9IHRoaXMuZ2V0X2ZpZWxkX3R5cGUobW9kZWxTY2hlbWEsIGspO1xuICAgICAgaWYgKCEoZmllbGR0eXBlIGluIFRZUEVfTUFQKSkge1xuICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgIHV0aWwuZm9ybWF0KCdHaXZlbiBzY2hlbWEgZmllbGQgdHlwZSBpcyBub3Qgc3VwcG9ydGVkIGZvcjogJXMoJXMpJywgaywgbW9kZWxTY2hlbWEuZmllbGRzW2tdLnR5cGUpLFxuICAgICAgICApKTtcbiAgICAgIH1cbiAgICAgIGlmICghKHRoaXMuaXNfZmllbGRfZGVmYXVsdF92YWx1ZV92YWxpZChtb2RlbFNjaGVtYSwgaykpKSB7XG4gICAgICAgIHRocm93IChuZXcgRXJyb3IoXG4gICAgICAgICAgdXRpbC5mb3JtYXQoJ0ludmFsaWQgZGVmdWx0IGRlZmluaXRpb24gZm9yOiAlcyglcyknLCBrLCBtb2RlbFNjaGVtYS5maWVsZHNba10udHlwZSksXG4gICAgICAgICkpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gdmFsaWRhdGUgcHJpbWFyeSBrZXlcbiAgICBpZiAodHlwZW9mIChtb2RlbFNjaGVtYS5rZXlbMF0pID09PSAnc3RyaW5nJykge1xuICAgICAgaWYgKCEobW9kZWxTY2hlbWEua2V5WzBdIGluIG1vZGVsU2NoZW1hLmZpZWxkcykpIHtcbiAgICAgICAgdGhyb3cgKG5ldyBFcnJvcignUGFydGl0aW9uIEtleSBtdXN0IGFsc28gYmUgYSB2YWxpZCBmaWVsZCBuYW1lJykpO1xuICAgICAgfVxuICAgICAgaWYgKG1vZGVsU2NoZW1hLmZpZWxkc1ttb2RlbFNjaGVtYS5rZXlbMF1dLnZpcnR1YWwpIHtcbiAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcIlBhcnRpdGlvbiBLZXkgbXVzdCBhbHNvIGJlIGEgZGIgZmllbGQgbmFtZSwgY2FuJ3QgYmUgYSB2aXJ0dWFsIGZpZWxkIG5hbWVcIikpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAobW9kZWxTY2hlbWEua2V5WzBdIGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICAgIGlmIChtb2RlbFNjaGVtYS5rZXlbMF0ubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IChuZXcgRXJyb3IoXCJQYXJ0aXRpb24gS2V5IGFycmF5IGNhbid0IGJlIGVtcHR5XCIpKTtcbiAgICAgIH1cbiAgICAgIGZvciAobGV0IGogPSAwOyBqIDwgbW9kZWxTY2hlbWEua2V5WzBdLmxlbmd0aDsgaisrKSB7XG4gICAgICAgIGlmICgodHlwZW9mIChtb2RlbFNjaGVtYS5rZXlbMF1bal0pICE9PSAnc3RyaW5nJykgfHwgIShtb2RlbFNjaGVtYS5rZXlbMF1bal0gaW4gbW9kZWxTY2hlbWEuZmllbGRzKSkge1xuICAgICAgICAgIHRocm93IChuZXcgRXJyb3IoJ1BhcnRpdGlvbiBLZXkgYXJyYXkgbXVzdCBjb250YWluIG9ubHkgdmFsaWQgZmllbGQgbmFtZXMnKSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG1vZGVsU2NoZW1hLmZpZWxkc1ttb2RlbFNjaGVtYS5rZXlbMF1bal1dLnZpcnR1YWwpIHtcbiAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgICAgXCJQYXJ0aXRpb24gS2V5IGFycmF5IG11c3QgY29udGFpbiBvbmx5IGRiIGZpZWxkIG5hbWVzLCBjYW4ndCBjb250YWluIHZpcnR1YWwgZmllbGQgbmFtZXNcIixcbiAgICAgICAgICApKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyAobmV3IEVycm9yKCdQYXJ0aXRpb24gS2V5IG11c3QgYmUgYSBmaWVsZCBuYW1lIHN0cmluZywgb3IgYXJyYXkgb2YgZmllbGQgbmFtZXMnKSk7XG4gICAgfVxuXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBtb2RlbFNjaGVtYS5rZXkubGVuZ3RoOyBpKyspIHtcbiAgICAgIGlmIChpID4gMCkge1xuICAgICAgICBpZiAoKHR5cGVvZiAobW9kZWxTY2hlbWEua2V5W2ldKSAhPT0gJ3N0cmluZycpIHx8ICEobW9kZWxTY2hlbWEua2V5W2ldIGluIG1vZGVsU2NoZW1hLmZpZWxkcykpIHtcbiAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKCdDbHVzdGVyaW5nIEtleXMgbXVzdCBiZSB2YWxpZCBmaWVsZCBuYW1lcycpKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobW9kZWxTY2hlbWEuZmllbGRzW21vZGVsU2NoZW1hLmtleVtpXV0udmlydHVhbCkge1xuICAgICAgICAgIHRocm93IChuZXcgRXJyb3IoXG4gICAgICAgICAgICBcIkNsdXN0ZXJpbmcgS2V5cyBtdXN0IGJlIGRiIGZpZWxkIG5hbWVzLCBjYW4ndCBiZSB2aXJ0dWFsIGZpZWxkIG5hbWVzXCIsXG4gICAgICAgICAgKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAobW9kZWxTY2hlbWEuY2x1c3RlcmluZ19vcmRlcikge1xuICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QobW9kZWxTY2hlbWEuY2x1c3RlcmluZ19vcmRlcikpIHtcbiAgICAgICAgdGhyb3cgKG5ldyBFcnJvcignY2x1c3RlcmluZ19vcmRlciBtdXN0IGJlIGFuIG9iamVjdCBvZiBjbHVzdGVyaW5nX2tleSBhdHRyaWJ1dGVzJykpO1xuICAgICAgfVxuXG4gICAgICBPYmplY3Qua2V5cyhtb2RlbFNjaGVtYS5jbHVzdGVyaW5nX29yZGVyKS5mb3JFYWNoKChjaW5kZXgpID0+IHtcbiAgICAgICAgaWYgKFsnYXNjJywgJ2Rlc2MnXS5pbmRleE9mKG1vZGVsU2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbY2luZGV4XS50b0xvd2VyQ2FzZSgpKSA9PT0gLTEpIHtcbiAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKCdjbHVzdGVyaW5nX29yZGVyIGF0dHJpYnV0ZSB2YWx1ZXMgY2FuIG9ubHkgYmUgQVNDIG9yIERFU0MnKSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG1vZGVsU2NoZW1hLmtleS5pbmRleE9mKGNpbmRleCkgPCAxKSB7XG4gICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcignY2x1c3RlcmluZ19vcmRlciBmaWVsZCBhdHRyaWJ1dGVzIG11c3QgYmUgY2x1c3RlcmluZyBrZXlzIG9ubHknKSk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIHZhbGlkYXRlIG1hdGVyaWFsaXplZF92aWV3XG4gICAgaWYgKG1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cykge1xuICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QobW9kZWxTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKSkge1xuICAgICAgICB0aHJvdyAobmV3IEVycm9yKCdtYXRlcmlhbGl6ZWRfdmlld3MgbXVzdCBiZSBhbiBvYmplY3Qgd2l0aCB2aWV3IG5hbWVzIGFzIGF0dHJpYnV0ZXMnKSk7XG4gICAgICB9XG5cbiAgICAgIE9iamVjdC5rZXlzKG1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cykuZm9yRWFjaCgobXZpbmRleCkgPT4ge1xuICAgICAgICBjb25zdCBjYW5kaWRhdGVNVmlldyA9IG1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1ttdmluZGV4XTtcbiAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QoY2FuZGlkYXRlTVZpZXcpKSB7XG4gICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAgIHV0aWwuZm9ybWF0KCdhdHRyaWJ1dGUgXCIlc1wiIHVuZGVyIG1hdGVyaWFsaXplZF92aWV3cyBtdXN0IGJlIGFuIG9iamVjdCcsIG12aW5kZXgpLFxuICAgICAgICAgICkpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFjYW5kaWRhdGVNVmlldy5zZWxlY3QgfHwgIWNhbmRpZGF0ZU1WaWV3LmtleSkge1xuICAgICAgICAgIHRocm93IChuZXcgRXJyb3IoXG4gICAgICAgICAgICB1dGlsLmZvcm1hdCgnbWF0ZXJpYWxpemVkX3ZpZXcgXCIlc1wiIG11c3QgaGF2ZSBcInNlbGVjdFwiIGFuZCBcImtleVwiIGF0dHJpYnV0ZXMnLCBtdmluZGV4KSxcbiAgICAgICAgICApKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghKGNhbmRpZGF0ZU1WaWV3LnNlbGVjdCBpbnN0YW5jZW9mIEFycmF5KSB8fCAhKGNhbmRpZGF0ZU1WaWV3LmtleSBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgICAgIHRocm93IChuZXcgRXJyb3IoXG4gICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgJ1wic2VsZWN0XCIgYW5kIFwia2V5XCIgYXR0cmlidXRlcyBtdXN0IGJlIGFuIGFycmF5IHVuZGVyIGF0dHJpYnV0ZSAlcyBvZiBtYXRlcmlhbGl6ZWRfdmlld3MnLCBtdmluZGV4LFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZvciAobGV0IHNlbGVjdGluZGV4ID0gMDsgc2VsZWN0aW5kZXggPCBjYW5kaWRhdGVNVmlldy5zZWxlY3QubGVuZ3RoOyBzZWxlY3RpbmRleCsrKSB7XG4gICAgICAgICAgaWYgKCh0eXBlb2YgKGNhbmRpZGF0ZU1WaWV3LnNlbGVjdFtzZWxlY3RpbmRleF0pICE9PSAnc3RyaW5nJylcbiAgICAgICAgICAgICAgICB8fCAhKGNhbmRpZGF0ZU1WaWV3LnNlbGVjdFtzZWxlY3RpbmRleF0gaW4gbW9kZWxTY2hlbWEuZmllbGRzXG4gICAgICAgICAgICAgICAgfHwgY2FuZGlkYXRlTVZpZXcuc2VsZWN0W3NlbGVjdGluZGV4XSA9PT0gJyonKSkge1xuICAgICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgdXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgJ3RoZSBzZWxlY3QgYXR0cmlidXRlIHVuZGVyIG1hdGVyaWFsaXplZF92aWV3ICVzIG11c3QgYmUgYW4gYXJyYXkgb2YgZmllbGQgbmFtZSBzdHJpbmdzIG9yIFtcIipcIl0nLFxuICAgICAgICAgICAgICAgIG12aW5kZXgsXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICApKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAobW9kZWxTY2hlbWEuZmllbGRzW2NhbmRpZGF0ZU1WaWV3LnNlbGVjdFtzZWxlY3RpbmRleF1dXG4gICAgICAgICAgICAgICYmIG1vZGVsU2NoZW1hLmZpZWxkc1tjYW5kaWRhdGVNVmlldy5zZWxlY3Rbc2VsZWN0aW5kZXhdXS52aXJ0dWFsKSB7XG4gICAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAndGhlIHNlbGVjdCBhdHRyaWJ1dGUgdW5kZXIgJXMgb2YgbWF0ZXJpYWxpemVkX3ZpZXdzIG11c3QgYmUgYW4gYXJyYXkgb2YgZGIgZmllbGQgbmFtZXMsICcgK1xuICAgICAgICAgICAgICAgICdjYW5ub3QgY29udGFpbiBhbnkgdmlydHVhbCBmaWVsZCBuYW1lJyxcbiAgICAgICAgICAgICAgICBtdmluZGV4LFxuICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gdmFsaWRhdGUgbWF0ZXJpYWxpemVkX3ZpZXcgcHJpbWFyeSBrZXlcbiAgICAgICAgaWYgKHR5cGVvZiAoY2FuZGlkYXRlTVZpZXcua2V5WzBdKSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICBpZiAoIShjYW5kaWRhdGVNVmlldy5rZXlbMF0gaW4gbW9kZWxTY2hlbWEuZmllbGRzKSkge1xuICAgICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgdXRpbC5mb3JtYXQoJ21hdGVyaWFsaXplZF92aWV3ICVzOiBwYXJ0aXRpb24ga2V5IHN0cmluZyBtdXN0IG1hdGNoIGEgdmFsaWQgZmllbGQgbmFtZScsIG12aW5kZXgpLFxuICAgICAgICAgICAgKSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChtb2RlbFNjaGVtYS5maWVsZHNbY2FuZGlkYXRlTVZpZXcua2V5WzBdXS52aXJ0dWFsKSB7XG4gICAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAnbWF0ZXJpYWxpemVkX3ZpZXcgJXM6IHBhcnRpdGlvbiBrZXkgbXVzdCBtYXRjaCBhIGRiIGZpZWxkIG5hbWUsIGNhbm5vdCBiZSBhIHZpcnR1YWwgZmllbGQgbmFtZScsXG4gICAgICAgICAgICAgICAgbXZpbmRleCxcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChjYW5kaWRhdGVNVmlldy5rZXlbMF0gaW5zdGFuY2VvZiBBcnJheSkge1xuICAgICAgICAgIGlmIChjYW5kaWRhdGVNVmlldy5rZXlbMF0ubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgICAgICB1dGlsLmZvcm1hdCgnbWF0ZXJpYWxpemVkX3ZpZXcgJXM6IHBhcnRpdGlvbiBrZXkgYXJyYXkgY2Fubm90IGJlIGVtcHR5JywgbXZpbmRleCksXG4gICAgICAgICAgICApKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZm9yIChsZXQgaiA9IDA7IGogPCBjYW5kaWRhdGVNVmlldy5rZXlbMF0ubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgICAgIGlmICgodHlwZW9mIChjYW5kaWRhdGVNVmlldy5rZXlbMF1bal0pICE9PSAnc3RyaW5nJykgfHwgIShjYW5kaWRhdGVNVmlldy5rZXlbMF1bal0gaW4gbW9kZWxTY2hlbWEuZmllbGRzKSkge1xuICAgICAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KCdtYXRlcmlhbGl6ZWRfdmlldyAlczogcGFydGl0aW9uIGtleSBhcnJheSBtdXN0IGNvbnRhaW4gb25seSB2YWxpZCBmaWVsZCBuYW1lcycsIG12aW5kZXgpLFxuICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChtb2RlbFNjaGVtYS5maWVsZHNbY2FuZGlkYXRlTVZpZXcua2V5WzBdW2pdXS52aXJ0dWFsKSB7XG4gICAgICAgICAgICAgIHRocm93IChuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgdXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgICAnbWF0ZXJpYWxpemVkX3ZpZXcgJXM6IHBhcnRpdGlvbiBrZXkgYXJyYXkgbXVzdCBjb250YWluIG9ubHkgZGIgZmllbGQgbmFtZXMsICcgK1xuICAgICAgICAgICAgICAgICAgJ2Nhbm5vdCBjb250YWluIHZpcnR1YWwgZmllbGQgbmFtZXMnLFxuICAgICAgICAgICAgICAgICAgbXZpbmRleCxcbiAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAnbWF0ZXJpYWxpemVkX3ZpZXcgJXM6IHBhcnRpdGlvbiBrZXkgbXVzdCBiZSBhIGZpZWxkIG5hbWUgc3RyaW5nLCBvciBhcnJheSBvZiBmaWVsZCBuYW1lcycsXG4gICAgICAgICAgICAgIG12aW5kZXgsXG4gICAgICAgICAgICApLFxuICAgICAgICAgICkpO1xuICAgICAgICB9XG5cbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBjYW5kaWRhdGVNVmlldy5rZXkubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICBpZiAoaSA+IDApIHtcbiAgICAgICAgICAgIGlmICgodHlwZW9mIChjYW5kaWRhdGVNVmlldy5rZXlbaV0pICE9PSAnc3RyaW5nJykgfHwgIShjYW5kaWRhdGVNVmlldy5rZXlbaV0gaW4gbW9kZWxTY2hlbWEuZmllbGRzKSkge1xuICAgICAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KCdtYXRlcmlhbGl6ZWRfdmlldyAlczogY2x1c3RlcmluZyBrZXlzIG11c3QgYmUgdmFsaWQgZmllbGQgbmFtZXMnLCBtdmluZGV4KSxcbiAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAobW9kZWxTY2hlbWEuZmllbGRzW2NhbmRpZGF0ZU1WaWV3LmtleVtpXV0udmlydHVhbCkge1xuICAgICAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgJ21hdGVyaWFsaXplZF92aWV3ICVzOiBjbHVzdGVyaW5nIGtleXMgbXVzdCBiZSBkYiBmaWVsZCBuYW1lcywgY2Fubm90IGNvbnRhaW4gdmlydHVhbCBmaWVsZHMnLFxuICAgICAgICAgICAgICAgICAgbXZpbmRleCxcbiAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY2FuZGlkYXRlTVZpZXcuY2x1c3RlcmluZ19vcmRlcikge1xuICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KGNhbmRpZGF0ZU1WaWV3LmNsdXN0ZXJpbmdfb3JkZXIpKSB7XG4gICAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAnbWF0ZXJpYWxpemVkX3ZpZXcgJXM6IGNsdXN0ZXJpbmdfb3JkZXIgbXVzdCBiZSBhbiBvYmplY3Qgb2YgY2x1c3RlcmluZ19rZXkgYXR0cmlidXRlcycsXG4gICAgICAgICAgICAgICAgbXZpbmRleCxcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICkpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIE9iamVjdC5rZXlzKGNhbmRpZGF0ZU1WaWV3LmNsdXN0ZXJpbmdfb3JkZXIpLmZvckVhY2goKGNpbmRleCkgPT4ge1xuICAgICAgICAgICAgaWYgKFsnYXNjJywgJ2Rlc2MnXS5pbmRleE9mKGNhbmRpZGF0ZU1WaWV3LmNsdXN0ZXJpbmdfb3JkZXJbY2luZGV4XS50b0xvd2VyQ2FzZSgpKSA9PT0gLTEpIHtcbiAgICAgICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICB1dGlsLmZvcm1hdCgnbWF0ZXJpYWxpemVkX3ZpZXcgJXM6IGNsdXN0ZXJpbmdfb3JkZXIgYXR0cmlidXRlIHZhbHVlcyBjYW4gb25seSBiZSBBU0Mgb3IgREVTQycsIG12aW5kZXgpLFxuICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChjYW5kaWRhdGVNVmlldy5rZXkuaW5kZXhPZihjaW5kZXgpIDwgMSkge1xuICAgICAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgJ21hdGVyaWFsaXplZF92aWV3ICVzOiBjbHVzdGVyaW5nX29yZGVyIGZpZWxkIGF0dHJpYnV0ZXMgbXVzdCBiZSBjbHVzdGVyaW5nIGtleXMgb25seScsXG4gICAgICAgICAgICAgICAgICBtdmluZGV4LFxuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyB2YWxpZGF0ZSBpbmRleGVzXG4gICAgaWYgKG1vZGVsU2NoZW1hLmluZGV4ZXMpIHtcbiAgICAgIGlmICghKG1vZGVsU2NoZW1hLmluZGV4ZXMgaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgICAgdGhyb3cgKG5ldyBFcnJvcignaW5kZXhlcyBtdXN0IGJlIGFuIGFycmF5IG9mIGZpZWxkIG5hbWUgc3RyaW5ncycpKTtcbiAgICAgIH1cblxuICAgICAgZm9yIChsZXQgbCA9IDA7IGwgPCBtb2RlbFNjaGVtYS5pbmRleGVzLmxlbmd0aDsgbCsrKSB7XG4gICAgICAgIGlmICh0eXBlb2YgbW9kZWxTY2hlbWEuaW5kZXhlc1tsXSAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKCdpbmRleGVzIG11c3QgYmUgYW4gYXJyYXkgb2Ygc3RyaW5ncycpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGluZGV4TmFtZUxpc3QgPSBtb2RlbFNjaGVtYS5pbmRleGVzW2xdLnJlcGxhY2UoL1tcIlxcc10vZywgJycpLnNwbGl0KC9bKCldL2cpO1xuICAgICAgICBpZiAoaW5kZXhOYW1lTGlzdC5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgaW5kZXhOYW1lTGlzdFswXSA9IGluZGV4TmFtZUxpc3RbMF0udG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICBpZiAoWydlbnRyaWVzJywgJ2tleXMnLCAndmFsdWVzJywgJ2Z1bGwnXS5pbmRleE9mKGluZGV4TmFtZUxpc3RbMF0pIDwgMCkge1xuICAgICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgdXRpbC5mb3JtYXQoJ2luZGV4IFwiJXNcIiBpcyBub3QgZGVmaW5lZCBwcm9wZXJseScsIG1vZGVsU2NoZW1hLmluZGV4ZXNbbF0pLFxuICAgICAgICAgICAgKSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICghKGluZGV4TmFtZUxpc3RbMV0gaW4gbW9kZWxTY2hlbWEuZmllbGRzKSkge1xuICAgICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgdXRpbC5mb3JtYXQoJ1wiJXNcIiBpcyBub3QgYSB2YWxpZCBmaWVsZCBuYW1lLCBpbmRleGVzIG11c3QgYmUgZGVmaW5lZCBvbiBmaWVsZCBuYW1lcycsIGluZGV4TmFtZUxpc3RbMV0pLFxuICAgICAgICAgICAgKSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChtb2RlbFNjaGVtYS5maWVsZHNbaW5kZXhOYW1lTGlzdFsxXV0udmlydHVhbCkge1xuICAgICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcImluZGV4ZXMgbXVzdCBiZSBhbiBhcnJheSBvZiBkYiBmaWVsZCBuYW1lcywgY2FuJ3QgY29udGFpbiB2aXJ0dWFsIGZpZWxkc1wiKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGlmICghKGluZGV4TmFtZUxpc3RbMF0gaW4gbW9kZWxTY2hlbWEuZmllbGRzKSkge1xuICAgICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgdXRpbC5mb3JtYXQoJ1wiJXNcIiBpcyBub3QgYSB2YWxpZCBmaWVsZCwgaW5kZXhlcyBtdXN0IGJlIGRlZmluZWQgb24gZmllbGQgbmFtZXMnLCBpbmRleE5hbWVMaXN0WzBdKSxcbiAgICAgICAgICAgICkpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAobW9kZWxTY2hlbWEuZmllbGRzW2luZGV4TmFtZUxpc3RbMF1dLnZpcnR1YWwpIHtcbiAgICAgICAgICAgIHRocm93IChuZXcgRXJyb3IoXCJpbmRleGVzIG11c3QgYmUgYW4gYXJyYXkgb2YgZGIgZmllbGQgbmFtZXMsIGNhbid0IGNvbnRhaW4gdmlydHVhbCBmaWVsZHNcIikpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHZhbGlkYXRlQ3VzdG9tSW5kZXggPSAoY3VzdG9tSW5kZXgpID0+IHtcbiAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KGN1c3RvbUluZGV4KSkge1xuICAgICAgICB0aHJvdyAobmV3IEVycm9yKCdjdXN0b21faW5kZXggbXVzdCBiZSBhbiBvYmplY3Qgd2l0aCBwcm9wZXIgaW5kZXhpbmcgYXR0cmlidXRlcycpKTtcbiAgICAgIH1cbiAgICAgIGlmICgodHlwZW9mIChjdXN0b21JbmRleC5vbikgIT09ICdzdHJpbmcnKSB8fCAhKGN1c3RvbUluZGV4Lm9uIGluIG1vZGVsU2NoZW1hLmZpZWxkcykpIHtcbiAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICBcImN1c3RvbV9pbmRleCBtdXN0IGhhdmUgYW4gJ29uJyBhdHRyaWJ1dGUgd2l0aCBzdHJpbmcgdmFsdWUgYW5kIHZhbHVlIG11c3QgYmUgYSB2YWxpZCBmaWVsZCBuYW1lXCIsXG4gICAgICAgICkpO1xuICAgICAgfVxuICAgICAgaWYgKG1vZGVsU2NoZW1hLmZpZWxkc1tjdXN0b21JbmRleC5vbl0udmlydHVhbCkge1xuICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgIFwiY3VzdG9tX2luZGV4ICdvbicgYXR0cmlidXRlIG11c3QgYmUgYSBkYiBmaWVsZCBuYW1lLCBjYW4ndCBjb250YWluIHZpcnR1YWwgZmllbGRzXCIsXG4gICAgICAgICkpO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiAoY3VzdG9tSW5kZXgudXNpbmcpICE9PSAnc3RyaW5nJykge1xuICAgICAgICB0aHJvdyAobmV3IEVycm9yKFxuICAgICAgICAgIFwiY3VzdG9tX2luZGV4IG11c3QgaGF2ZSBhICd1c2luZycgYXR0cmlidXRlIHdpdGggc3RyaW5nIHZhbHVlXCIsXG4gICAgICAgICkpO1xuICAgICAgfVxuICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QoY3VzdG9tSW5kZXgub3B0aW9ucykpIHtcbiAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAnY3VzdG9tX2luZGV4IG11c3QgaGF2ZSBhbiBcIm9wdGlvbnNcIiBhdHRyaWJ1dGUgYW5kIGl0IG11c3QgYmUgYW4gb2JqZWN0LCAnICtcbiAgICAgICAgICAncGFzcyBibGFuayB7fSBvYmplY3QgaWYgbm8gb3B0aW9ucyBhcmUgcmVxdWlyZWQnLFxuICAgICAgICApKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgaWYgKG1vZGVsU2NoZW1hLmN1c3RvbV9pbmRleCAmJiBtb2RlbFNjaGVtYS5jdXN0b21faW5kZXhlcykge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgJ2JvdGggY3VzdG9tX2luZGV4IGFuZCBjdXN0b21faW5kZXhlcyBhcmUgZGVmaW5lZCBpbiBzY2hlbWEsIG9ubHkgb25lIG9mIHRoZW0gc2hvdWxkIGJlIGRlZmluZWQnLFxuICAgICAgKSk7XG4gICAgfVxuXG4gICAgaWYgKG1vZGVsU2NoZW1hLmN1c3RvbV9pbmRleCkge1xuICAgICAgdmFsaWRhdGVDdXN0b21JbmRleChtb2RlbFNjaGVtYS5jdXN0b21faW5kZXgpO1xuICAgIH1cblxuICAgIGlmIChtb2RlbFNjaGVtYS5jdXN0b21faW5kZXhlcykge1xuICAgICAgaWYgKG1vZGVsU2NoZW1hLmN1c3RvbV9pbmRleGVzIGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICAgICAgZm9yIChsZXQgY2kgPSAwOyBjaSA8IG1vZGVsU2NoZW1hLmN1c3RvbV9pbmRleGVzLmxlbmd0aDsgY2krKykge1xuICAgICAgICAgIHZhbGlkYXRlQ3VzdG9tSW5kZXgobW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4ZXNbY2ldKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcbiAgICAgICAgICAnY3VzdG9tX2luZGV4ZXMgbXVzdCBiZSBhbiBhcnJheSB3aXRoIG9iamVjdHMgd2l0aCBwcm9wZXIgaW5kZXhpbmcgYXR0cmlidXRlcycsXG4gICAgICAgICkpO1xuICAgICAgfVxuICAgIH1cbiAgfSxcblxuICBnZXRfZmllbGRfdHlwZShtb2RlbFNjaGVtYSwgZmllbGRuYW1lKSB7XG4gICAgY29uc3QgZmllbGRvYiA9IG1vZGVsU2NoZW1hLmZpZWxkc1tmaWVsZG5hbWVdO1xuXG4gICAgaWYgKHR5cGVvZiBmaWVsZG9iID09PSAnc3RyaW5nJykgcmV0dXJuIGZpZWxkb2I7XG4gICAgZWxzZSBpZiAoXy5pc1BsYWluT2JqZWN0KGZpZWxkb2IpKSByZXR1cm4gZmllbGRvYi50eXBlO1xuICAgIHRocm93IChuZXcgRXJyb3IodXRpbC5mb3JtYXQoJ0ZpZWxkIHR5cGUgbm90IGRlZmluZWQgZm9yIGZpZWxkIFwiJXNcIicsIGZpZWxkbmFtZSkpKTtcbiAgfSxcblxuICBpc19maWVsZF9kZWZhdWx0X3ZhbHVlX3ZhbGlkKG1vZGVsU2NoZW1hLCBmaWVsZG5hbWUpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG1vZGVsU2NoZW1hLmZpZWxkc1tmaWVsZG5hbWVdKSAmJiBtb2RlbFNjaGVtYS5maWVsZHNbZmllbGRuYW1lXS5kZWZhdWx0KSB7XG4gICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG1vZGVsU2NoZW1hLmZpZWxkc1tmaWVsZG5hbWVdLmRlZmF1bHQpXG4gICAgICAgICAgJiYgIShtb2RlbFNjaGVtYS5maWVsZHNbZmllbGRuYW1lXS5kZWZhdWx0LiRkYl9mdW5jdGlvbikpIHtcbiAgICAgICAgaWYgKFsnbWFwJywgJ2xpc3QnLCAnc2V0JywgJ2Zyb3plbiddLmluZGV4T2YobW9kZWxTY2hlbWEuZmllbGRzW2ZpZWxkbmFtZV0udHlwZSkgPiAtMSkgcmV0dXJuIHRydWU7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSxcblxufTtcblxubW9kdWxlLmV4cG9ydHMgPSBzY2hlbWVyO1xuIl19