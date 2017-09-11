'use strict';

var util = require('util');

var AERROR_TYPES = {
  unspecified: {
    msg: 'Unspecified error ->'
  },
  'model.validator.invalidconfig': {
    msg: '%s'
  },
  'model.validator.invalidudt': {
    msg: '%s'
  },
  'model.validator.invalidudf': {
    msg: '%s'
  },
  'model.validator.invaliduda': {
    msg: '%s'
  },
  'model.validator.invalidschema': {
    msg: '%s'
  },
  'model.validator.invalidrule': {
    msg: '%s'
  },
  'model.validator.invalidvalue': {
    msg: '%s'
  },
  'model.tablecreation.invalidname': {
    msg: 'Table names only allow alphanumeric and _ and must start with a letter, got %s'
  },
  'model.tablecreation.dbschemaquery': {
    msg: 'Error while retrieveing Schema of DB Table "%s"'
  },
  'model.tablecreation.schemamismatch': {
    msg: 'Given Schema does not match existing DB Table "%s"'
  },
  'model.tablecreation.dbcreate': {
    msg: 'Error while creating DB Table -> %s'
  },
  'model.tablecreation.dbalter': {
    msg: 'Error while altering DB Table -> %s'
  },
  'model.tablecreation.dbdrop': {
    msg: 'Error while dropping DB Table -> %s'
  },
  'model.tablecreation.dbindexcreate': {
    msg: 'Error while creating index on DB Table -> %s'
  },
  'model.tablecreation.dbindexdrop': {
    msg: 'Error while dropping index on DB Table -> %s'
  },
  'model.tablecreation.matviewcreate': {
    msg: 'Error while creating materialized view on DB Table -> %s'
  },
  'model.tablecreation.matviewdrop': {
    msg: 'Error while dropping materialized view on DB Table -> %s'
  },
  'model.find.invalidop': {
    msg: 'Invalid field relation: unknown operator: "%s"'
  },
  'model.find.invalidexpr': {
    msg: '$expr must be an object containing the index name as string and query as string.'
  },
  'model.find.invalidsolrquery': {
    msg: '$solr_query must be a string containing the query for solr.'
  },
  'model.find.invalidorder': {
    msg: 'Invalid $orderby query, $orderby must be an object'
  },
  'model.find.multiorder': {
    msg: 'Invalid $orderby query: only one clause per object is allowed'
  },
  'model.find.invalidordertype': {
    msg: 'Invalid $orderby query, allowed order: $asc / $desc, given "%s"'
  },
  'model.find.limittype': {
    msg: '$limit must be an integer, given value "%s"'
  },
  'model.find.invalidinop': {
    msg: 'Invalid $in query. $in must be an array'
  },
  'model.find.invalidcontainsop': {
    msg: 'Invalid $contains query, $contains operator is only valid for indexed collections'
  },
  'model.find.invalidcontainskeyop': {
    msg: 'Invalid $contains_key query, $contains_key operator is only valid for indexed map collections'
  },
  'model.find.invalidtoken': {
    msg: 'Invalid $token query. $token must be an object with operator values'
  },
  'model.find.invalidtokenop': {
    msg: 'Invalid operator: "%s" in $token query'
  },
  'model.find.streamerror': {
    msg: 'Invalid stream query -> %s'
  },
  'model.find.eachrowerror': {
    msg: 'Invalid eachRow query -> %s'
  },
  'model.find.cberror': {
    msg: 'No valid callback function was provided'
  },
  'model.find.dberror': {
    msg: 'Error during find query on DB -> %s'
  },
  'model.save.unsetkey': {
    msg: 'Primary Key Field: %s must have a value'
  },
  'model.save.unsetrequired': {
    msg: 'Required Field: %s must have a value'
  },
  'model.save.invaliddefaultvalue': {
    msg: 'Invalid Default value: "%s" for Field: %s (Type: %s)'
  },
  'model.save.dberror': {
    msg: 'Error during save query on DB -> %s'
  },
  'model.save.before.error': {
    msg: 'Error in before_save lifecycle function -> %s'
  },
  'model.save.after.error': {
    msg: 'Error in after_save lifecycle function -> %s'
  },
  'model.update.unsetkey': {
    msg: 'Primary Key Field: %s must have a value'
  },
  'model.update.unsetrequired': {
    msg: 'Required Field: %s must have a value'
  },
  'model.update.invaliddefaultvalue': {
    msg: 'Invalid Default value: "%s" for Field: %s (Type: %s)'
  },
  'model.update.invalidreplaceop': {
    msg: 'Invalid $replace operation -> %s'
  },
  'model.update.invalidprependop': {
    msg: 'Invalid $prepend operation -> %s'
  },
  'model.update.dberror': {
    msg: 'Error during update query on DB -> %s'
  },
  'model.update.before.error': {
    msg: 'Error in before_update lifecycle function -> %s'
  },
  'model.update.after.error': {
    msg: 'Error in after_update lifecycle function -> %s'
  },
  'model.delete.dberror': {
    msg: 'Error during delete query on DB -> %s'
  },
  'model.delete.before.error': {
    msg: 'Error in before_delete lifecycle function -> %s'
  },
  'model.delete.after.error': {
    msg: 'Error in after_delete lifecycle function -> %s'
  }
};

var ERR_NAME_PREFIX = 'apollo';

var buildError = function f() {
  for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
    args[_key] = arguments[_key];
  }

  var argsarray = args;
  var name = argsarray.length ? argsarray.shift() : '_none_given_';

  var errorTemplate = AERROR_TYPES[name] || AERROR_TYPES.unspecified;
  var errorMsg = argsarray.length ? util.format.apply(this, [errorTemplate.msg].concat(argsarray)) : errorTemplate.msg;

  var error = new Error(errorMsg);
  error.name = (ERR_NAME_PREFIX ? util.format('%s.', ERR_NAME_PREFIX) : '') + name;

  return error;
};

module.exports = buildError;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9vcm0vYXBvbGxvX2Vycm9yLmpzIl0sIm5hbWVzIjpbInV0aWwiLCJyZXF1aXJlIiwiQUVSUk9SX1RZUEVTIiwidW5zcGVjaWZpZWQiLCJtc2ciLCJFUlJfTkFNRV9QUkVGSVgiLCJidWlsZEVycm9yIiwiZiIsImFyZ3MiLCJhcmdzYXJyYXkiLCJuYW1lIiwibGVuZ3RoIiwic2hpZnQiLCJlcnJvclRlbXBsYXRlIiwiZXJyb3JNc2ciLCJmb3JtYXQiLCJhcHBseSIsImNvbmNhdCIsImVycm9yIiwiRXJyb3IiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOztBQUFBLElBQU1BLE9BQU9DLFFBQVEsTUFBUixDQUFiOztBQUVBLElBQU1DLGVBQWU7QUFDbkJDLGVBQWE7QUFDWEMsU0FBSztBQURNLEdBRE07QUFJbkIsbUNBQWlDO0FBQy9CQSxTQUFLO0FBRDBCLEdBSmQ7QUFPbkIsZ0NBQThCO0FBQzVCQSxTQUFLO0FBRHVCLEdBUFg7QUFVbkIsZ0NBQThCO0FBQzVCQSxTQUFLO0FBRHVCLEdBVlg7QUFhbkIsZ0NBQThCO0FBQzVCQSxTQUFLO0FBRHVCLEdBYlg7QUFnQm5CLG1DQUFpQztBQUMvQkEsU0FBSztBQUQwQixHQWhCZDtBQW1CbkIsaUNBQStCO0FBQzdCQSxTQUFLO0FBRHdCLEdBbkJaO0FBc0JuQixrQ0FBZ0M7QUFDOUJBLFNBQUs7QUFEeUIsR0F0QmI7QUF5Qm5CLHFDQUFtQztBQUNqQ0EsU0FBSztBQUQ0QixHQXpCaEI7QUE0Qm5CLHVDQUFxQztBQUNuQ0EsU0FBSztBQUQ4QixHQTVCbEI7QUErQm5CLHdDQUFzQztBQUNwQ0EsU0FBSztBQUQrQixHQS9CbkI7QUFrQ25CLGtDQUFnQztBQUM5QkEsU0FBSztBQUR5QixHQWxDYjtBQXFDbkIsaUNBQStCO0FBQzdCQSxTQUFLO0FBRHdCLEdBckNaO0FBd0NuQixnQ0FBOEI7QUFDNUJBLFNBQUs7QUFEdUIsR0F4Q1g7QUEyQ25CLHVDQUFxQztBQUNuQ0EsU0FBSztBQUQ4QixHQTNDbEI7QUE4Q25CLHFDQUFtQztBQUNqQ0EsU0FBSztBQUQ0QixHQTlDaEI7QUFpRG5CLHVDQUFxQztBQUNuQ0EsU0FBSztBQUQ4QixHQWpEbEI7QUFvRG5CLHFDQUFtQztBQUNqQ0EsU0FBSztBQUQ0QixHQXBEaEI7QUF1RG5CLDBCQUF3QjtBQUN0QkEsU0FBSztBQURpQixHQXZETDtBQTBEbkIsNEJBQTBCO0FBQ3hCQSxTQUFLO0FBRG1CLEdBMURQO0FBNkRuQixpQ0FBK0I7QUFDN0JBLFNBQUs7QUFEd0IsR0E3RFo7QUFnRW5CLDZCQUEyQjtBQUN6QkEsU0FBSztBQURvQixHQWhFUjtBQW1FbkIsMkJBQXlCO0FBQ3ZCQSxTQUFLO0FBRGtCLEdBbkVOO0FBc0VuQixpQ0FBK0I7QUFDN0JBLFNBQUs7QUFEd0IsR0F0RVo7QUF5RW5CLDBCQUF3QjtBQUN0QkEsU0FBSztBQURpQixHQXpFTDtBQTRFbkIsNEJBQTBCO0FBQ3hCQSxTQUFLO0FBRG1CLEdBNUVQO0FBK0VuQixrQ0FBZ0M7QUFDOUJBLFNBQUs7QUFEeUIsR0EvRWI7QUFrRm5CLHFDQUFtQztBQUNqQ0EsU0FBSztBQUQ0QixHQWxGaEI7QUFxRm5CLDZCQUEyQjtBQUN6QkEsU0FBSztBQURvQixHQXJGUjtBQXdGbkIsK0JBQTZCO0FBQzNCQSxTQUFLO0FBRHNCLEdBeEZWO0FBMkZuQiw0QkFBMEI7QUFDeEJBLFNBQUs7QUFEbUIsR0EzRlA7QUE4Rm5CLDZCQUEyQjtBQUN6QkEsU0FBSztBQURvQixHQTlGUjtBQWlHbkIsd0JBQXNCO0FBQ3BCQSxTQUFLO0FBRGUsR0FqR0g7QUFvR25CLHdCQUFzQjtBQUNwQkEsU0FBSztBQURlLEdBcEdIO0FBdUduQix5QkFBdUI7QUFDckJBLFNBQUs7QUFEZ0IsR0F2R0o7QUEwR25CLDhCQUE0QjtBQUMxQkEsU0FBSztBQURxQixHQTFHVDtBQTZHbkIsb0NBQWtDO0FBQ2hDQSxTQUFLO0FBRDJCLEdBN0dmO0FBZ0huQix3QkFBc0I7QUFDcEJBLFNBQUs7QUFEZSxHQWhISDtBQW1IbkIsNkJBQTJCO0FBQ3pCQSxTQUFLO0FBRG9CLEdBbkhSO0FBc0huQiw0QkFBMEI7QUFDeEJBLFNBQUs7QUFEbUIsR0F0SFA7QUF5SG5CLDJCQUF5QjtBQUN2QkEsU0FBSztBQURrQixHQXpITjtBQTRIbkIsZ0NBQThCO0FBQzVCQSxTQUFLO0FBRHVCLEdBNUhYO0FBK0huQixzQ0FBb0M7QUFDbENBLFNBQUs7QUFENkIsR0EvSGpCO0FBa0luQixtQ0FBaUM7QUFDL0JBLFNBQUs7QUFEMEIsR0FsSWQ7QUFxSW5CLG1DQUFpQztBQUMvQkEsU0FBSztBQUQwQixHQXJJZDtBQXdJbkIsMEJBQXdCO0FBQ3RCQSxTQUFLO0FBRGlCLEdBeElMO0FBMkluQiwrQkFBNkI7QUFDM0JBLFNBQUs7QUFEc0IsR0EzSVY7QUE4SW5CLDhCQUE0QjtBQUMxQkEsU0FBSztBQURxQixHQTlJVDtBQWlKbkIsMEJBQXdCO0FBQ3RCQSxTQUFLO0FBRGlCLEdBakpMO0FBb0puQiwrQkFBNkI7QUFDM0JBLFNBQUs7QUFEc0IsR0FwSlY7QUF1Sm5CLDhCQUE0QjtBQUMxQkEsU0FBSztBQURxQjtBQXZKVCxDQUFyQjs7QUE0SkEsSUFBTUMsa0JBQWtCLFFBQXhCOztBQUVBLElBQU1DLGFBQWEsU0FBU0MsQ0FBVCxHQUFvQjtBQUFBLG9DQUFOQyxJQUFNO0FBQU5BLFFBQU07QUFBQTs7QUFDckMsTUFBTUMsWUFBWUQsSUFBbEI7QUFDQSxNQUFNRSxPQUFPRCxVQUFVRSxNQUFWLEdBQW1CRixVQUFVRyxLQUFWLEVBQW5CLEdBQXVDLGNBQXBEOztBQUVBLE1BQU1DLGdCQUFnQlgsYUFBYVEsSUFBYixLQUFzQlIsYUFBYUMsV0FBekQ7QUFDQSxNQUFNVyxXQUFXTCxVQUFVRSxNQUFWLEdBQ2ZYLEtBQUtlLE1BQUwsQ0FBWUMsS0FBWixDQUFrQixJQUFsQixFQUF3QixDQUFDSCxjQUFjVCxHQUFmLEVBQW9CYSxNQUFwQixDQUEyQlIsU0FBM0IsQ0FBeEIsQ0FEZSxHQUVmSSxjQUFjVCxHQUZoQjs7QUFJQSxNQUFNYyxRQUFRLElBQUlDLEtBQUosQ0FBVUwsUUFBVixDQUFkO0FBQ0FJLFFBQU1SLElBQU4sR0FBYSxDQUFDTCxrQkFBa0JMLEtBQUtlLE1BQUwsQ0FBWSxLQUFaLEVBQW1CVixlQUFuQixDQUFsQixHQUF3RCxFQUF6RCxJQUErREssSUFBNUU7O0FBRUEsU0FBT1EsS0FBUDtBQUNELENBYkQ7O0FBZUFFLE9BQU9DLE9BQVAsR0FBaUJmLFVBQWpCIiwiZmlsZSI6ImFwb2xsb19lcnJvci5qcyIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHV0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG5cbmNvbnN0IEFFUlJPUl9UWVBFUyA9IHtcbiAgdW5zcGVjaWZpZWQ6IHtcbiAgICBtc2c6ICdVbnNwZWNpZmllZCBlcnJvciAtPicsXG4gIH0sXG4gICdtb2RlbC52YWxpZGF0b3IuaW52YWxpZGNvbmZpZyc6IHtcbiAgICBtc2c6ICclcycsXG4gIH0sXG4gICdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHVkdCc6IHtcbiAgICBtc2c6ICclcycsXG4gIH0sXG4gICdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHVkZic6IHtcbiAgICBtc2c6ICclcycsXG4gIH0sXG4gICdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHVkYSc6IHtcbiAgICBtc2c6ICclcycsXG4gIH0sXG4gICdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHNjaGVtYSc6IHtcbiAgICBtc2c6ICclcycsXG4gIH0sXG4gICdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHJ1bGUnOiB7XG4gICAgbXNnOiAnJXMnLFxuICB9LFxuICAnbW9kZWwudmFsaWRhdG9yLmludmFsaWR2YWx1ZSc6IHtcbiAgICBtc2c6ICclcycsXG4gIH0sXG4gICdtb2RlbC50YWJsZWNyZWF0aW9uLmludmFsaWRuYW1lJzoge1xuICAgIG1zZzogJ1RhYmxlIG5hbWVzIG9ubHkgYWxsb3cgYWxwaGFudW1lcmljIGFuZCBfIGFuZCBtdXN0IHN0YXJ0IHdpdGggYSBsZXR0ZXIsIGdvdCAlcycsXG4gIH0sXG4gICdtb2RlbC50YWJsZWNyZWF0aW9uLmRic2NoZW1hcXVlcnknOiB7XG4gICAgbXNnOiAnRXJyb3Igd2hpbGUgcmV0cmlldmVpbmcgU2NoZW1hIG9mIERCIFRhYmxlIFwiJXNcIicsXG4gIH0sXG4gICdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJzoge1xuICAgIG1zZzogJ0dpdmVuIFNjaGVtYSBkb2VzIG5vdCBtYXRjaCBleGlzdGluZyBEQiBUYWJsZSBcIiVzXCInLFxuICB9LFxuICAnbW9kZWwudGFibGVjcmVhdGlvbi5kYmNyZWF0ZSc6IHtcbiAgICBtc2c6ICdFcnJvciB3aGlsZSBjcmVhdGluZyBEQiBUYWJsZSAtPiAlcycsXG4gIH0sXG4gICdtb2RlbC50YWJsZWNyZWF0aW9uLmRiYWx0ZXInOiB7XG4gICAgbXNnOiAnRXJyb3Igd2hpbGUgYWx0ZXJpbmcgREIgVGFibGUgLT4gJXMnLFxuICB9LFxuICAnbW9kZWwudGFibGVjcmVhdGlvbi5kYmRyb3AnOiB7XG4gICAgbXNnOiAnRXJyb3Igd2hpbGUgZHJvcHBpbmcgREIgVGFibGUgLT4gJXMnLFxuICB9LFxuICAnbW9kZWwudGFibGVjcmVhdGlvbi5kYmluZGV4Y3JlYXRlJzoge1xuICAgIG1zZzogJ0Vycm9yIHdoaWxlIGNyZWF0aW5nIGluZGV4IG9uIERCIFRhYmxlIC0+ICVzJyxcbiAgfSxcbiAgJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJpbmRleGRyb3AnOiB7XG4gICAgbXNnOiAnRXJyb3Igd2hpbGUgZHJvcHBpbmcgaW5kZXggb24gREIgVGFibGUgLT4gJXMnLFxuICB9LFxuICAnbW9kZWwudGFibGVjcmVhdGlvbi5tYXR2aWV3Y3JlYXRlJzoge1xuICAgIG1zZzogJ0Vycm9yIHdoaWxlIGNyZWF0aW5nIG1hdGVyaWFsaXplZCB2aWV3IG9uIERCIFRhYmxlIC0+ICVzJyxcbiAgfSxcbiAgJ21vZGVsLnRhYmxlY3JlYXRpb24ubWF0dmlld2Ryb3AnOiB7XG4gICAgbXNnOiAnRXJyb3Igd2hpbGUgZHJvcHBpbmcgbWF0ZXJpYWxpemVkIHZpZXcgb24gREIgVGFibGUgLT4gJXMnLFxuICB9LFxuICAnbW9kZWwuZmluZC5pbnZhbGlkb3AnOiB7XG4gICAgbXNnOiAnSW52YWxpZCBmaWVsZCByZWxhdGlvbjogdW5rbm93biBvcGVyYXRvcjogXCIlc1wiJyxcbiAgfSxcbiAgJ21vZGVsLmZpbmQuaW52YWxpZGV4cHInOiB7XG4gICAgbXNnOiAnJGV4cHIgbXVzdCBiZSBhbiBvYmplY3QgY29udGFpbmluZyB0aGUgaW5kZXggbmFtZSBhcyBzdHJpbmcgYW5kIHF1ZXJ5IGFzIHN0cmluZy4nLFxuICB9LFxuICAnbW9kZWwuZmluZC5pbnZhbGlkc29scnF1ZXJ5Jzoge1xuICAgIG1zZzogJyRzb2xyX3F1ZXJ5IG11c3QgYmUgYSBzdHJpbmcgY29udGFpbmluZyB0aGUgcXVlcnkgZm9yIHNvbHIuJyxcbiAgfSxcbiAgJ21vZGVsLmZpbmQuaW52YWxpZG9yZGVyJzoge1xuICAgIG1zZzogJ0ludmFsaWQgJG9yZGVyYnkgcXVlcnksICRvcmRlcmJ5IG11c3QgYmUgYW4gb2JqZWN0JyxcbiAgfSxcbiAgJ21vZGVsLmZpbmQubXVsdGlvcmRlcic6IHtcbiAgICBtc2c6ICdJbnZhbGlkICRvcmRlcmJ5IHF1ZXJ5OiBvbmx5IG9uZSBjbGF1c2UgcGVyIG9iamVjdCBpcyBhbGxvd2VkJyxcbiAgfSxcbiAgJ21vZGVsLmZpbmQuaW52YWxpZG9yZGVydHlwZSc6IHtcbiAgICBtc2c6ICdJbnZhbGlkICRvcmRlcmJ5IHF1ZXJ5LCBhbGxvd2VkIG9yZGVyOiAkYXNjIC8gJGRlc2MsIGdpdmVuIFwiJXNcIicsXG4gIH0sXG4gICdtb2RlbC5maW5kLmxpbWl0dHlwZSc6IHtcbiAgICBtc2c6ICckbGltaXQgbXVzdCBiZSBhbiBpbnRlZ2VyLCBnaXZlbiB2YWx1ZSBcIiVzXCInLFxuICB9LFxuICAnbW9kZWwuZmluZC5pbnZhbGlkaW5vcCc6IHtcbiAgICBtc2c6ICdJbnZhbGlkICRpbiBxdWVyeS4gJGluIG11c3QgYmUgYW4gYXJyYXknLFxuICB9LFxuICAnbW9kZWwuZmluZC5pbnZhbGlkY29udGFpbnNvcCc6IHtcbiAgICBtc2c6ICdJbnZhbGlkICRjb250YWlucyBxdWVyeSwgJGNvbnRhaW5zIG9wZXJhdG9yIGlzIG9ubHkgdmFsaWQgZm9yIGluZGV4ZWQgY29sbGVjdGlvbnMnLFxuICB9LFxuICAnbW9kZWwuZmluZC5pbnZhbGlkY29udGFpbnNrZXlvcCc6IHtcbiAgICBtc2c6ICdJbnZhbGlkICRjb250YWluc19rZXkgcXVlcnksICRjb250YWluc19rZXkgb3BlcmF0b3IgaXMgb25seSB2YWxpZCBmb3IgaW5kZXhlZCBtYXAgY29sbGVjdGlvbnMnLFxuICB9LFxuICAnbW9kZWwuZmluZC5pbnZhbGlkdG9rZW4nOiB7XG4gICAgbXNnOiAnSW52YWxpZCAkdG9rZW4gcXVlcnkuICR0b2tlbiBtdXN0IGJlIGFuIG9iamVjdCB3aXRoIG9wZXJhdG9yIHZhbHVlcycsXG4gIH0sXG4gICdtb2RlbC5maW5kLmludmFsaWR0b2tlbm9wJzoge1xuICAgIG1zZzogJ0ludmFsaWQgb3BlcmF0b3I6IFwiJXNcIiBpbiAkdG9rZW4gcXVlcnknLFxuICB9LFxuICAnbW9kZWwuZmluZC5zdHJlYW1lcnJvcic6IHtcbiAgICBtc2c6ICdJbnZhbGlkIHN0cmVhbSBxdWVyeSAtPiAlcycsXG4gIH0sXG4gICdtb2RlbC5maW5kLmVhY2hyb3dlcnJvcic6IHtcbiAgICBtc2c6ICdJbnZhbGlkIGVhY2hSb3cgcXVlcnkgLT4gJXMnLFxuICB9LFxuICAnbW9kZWwuZmluZC5jYmVycm9yJzoge1xuICAgIG1zZzogJ05vIHZhbGlkIGNhbGxiYWNrIGZ1bmN0aW9uIHdhcyBwcm92aWRlZCcsXG4gIH0sXG4gICdtb2RlbC5maW5kLmRiZXJyb3InOiB7XG4gICAgbXNnOiAnRXJyb3IgZHVyaW5nIGZpbmQgcXVlcnkgb24gREIgLT4gJXMnLFxuICB9LFxuICAnbW9kZWwuc2F2ZS51bnNldGtleSc6IHtcbiAgICBtc2c6ICdQcmltYXJ5IEtleSBGaWVsZDogJXMgbXVzdCBoYXZlIGEgdmFsdWUnLFxuICB9LFxuICAnbW9kZWwuc2F2ZS51bnNldHJlcXVpcmVkJzoge1xuICAgIG1zZzogJ1JlcXVpcmVkIEZpZWxkOiAlcyBtdXN0IGhhdmUgYSB2YWx1ZScsXG4gIH0sXG4gICdtb2RlbC5zYXZlLmludmFsaWRkZWZhdWx0dmFsdWUnOiB7XG4gICAgbXNnOiAnSW52YWxpZCBEZWZhdWx0IHZhbHVlOiBcIiVzXCIgZm9yIEZpZWxkOiAlcyAoVHlwZTogJXMpJyxcbiAgfSxcbiAgJ21vZGVsLnNhdmUuZGJlcnJvcic6IHtcbiAgICBtc2c6ICdFcnJvciBkdXJpbmcgc2F2ZSBxdWVyeSBvbiBEQiAtPiAlcycsXG4gIH0sXG4gICdtb2RlbC5zYXZlLmJlZm9yZS5lcnJvcic6IHtcbiAgICBtc2c6ICdFcnJvciBpbiBiZWZvcmVfc2F2ZSBsaWZlY3ljbGUgZnVuY3Rpb24gLT4gJXMnLFxuICB9LFxuICAnbW9kZWwuc2F2ZS5hZnRlci5lcnJvcic6IHtcbiAgICBtc2c6ICdFcnJvciBpbiBhZnRlcl9zYXZlIGxpZmVjeWNsZSBmdW5jdGlvbiAtPiAlcycsXG4gIH0sXG4gICdtb2RlbC51cGRhdGUudW5zZXRrZXknOiB7XG4gICAgbXNnOiAnUHJpbWFyeSBLZXkgRmllbGQ6ICVzIG11c3QgaGF2ZSBhIHZhbHVlJyxcbiAgfSxcbiAgJ21vZGVsLnVwZGF0ZS51bnNldHJlcXVpcmVkJzoge1xuICAgIG1zZzogJ1JlcXVpcmVkIEZpZWxkOiAlcyBtdXN0IGhhdmUgYSB2YWx1ZScsXG4gIH0sXG4gICdtb2RlbC51cGRhdGUuaW52YWxpZGRlZmF1bHR2YWx1ZSc6IHtcbiAgICBtc2c6ICdJbnZhbGlkIERlZmF1bHQgdmFsdWU6IFwiJXNcIiBmb3IgRmllbGQ6ICVzIChUeXBlOiAlcyknLFxuICB9LFxuICAnbW9kZWwudXBkYXRlLmludmFsaWRyZXBsYWNlb3AnOiB7XG4gICAgbXNnOiAnSW52YWxpZCAkcmVwbGFjZSBvcGVyYXRpb24gLT4gJXMnLFxuICB9LFxuICAnbW9kZWwudXBkYXRlLmludmFsaWRwcmVwZW5kb3AnOiB7XG4gICAgbXNnOiAnSW52YWxpZCAkcHJlcGVuZCBvcGVyYXRpb24gLT4gJXMnLFxuICB9LFxuICAnbW9kZWwudXBkYXRlLmRiZXJyb3InOiB7XG4gICAgbXNnOiAnRXJyb3IgZHVyaW5nIHVwZGF0ZSBxdWVyeSBvbiBEQiAtPiAlcycsXG4gIH0sXG4gICdtb2RlbC51cGRhdGUuYmVmb3JlLmVycm9yJzoge1xuICAgIG1zZzogJ0Vycm9yIGluIGJlZm9yZV91cGRhdGUgbGlmZWN5Y2xlIGZ1bmN0aW9uIC0+ICVzJyxcbiAgfSxcbiAgJ21vZGVsLnVwZGF0ZS5hZnRlci5lcnJvcic6IHtcbiAgICBtc2c6ICdFcnJvciBpbiBhZnRlcl91cGRhdGUgbGlmZWN5Y2xlIGZ1bmN0aW9uIC0+ICVzJyxcbiAgfSxcbiAgJ21vZGVsLmRlbGV0ZS5kYmVycm9yJzoge1xuICAgIG1zZzogJ0Vycm9yIGR1cmluZyBkZWxldGUgcXVlcnkgb24gREIgLT4gJXMnLFxuICB9LFxuICAnbW9kZWwuZGVsZXRlLmJlZm9yZS5lcnJvcic6IHtcbiAgICBtc2c6ICdFcnJvciBpbiBiZWZvcmVfZGVsZXRlIGxpZmVjeWNsZSBmdW5jdGlvbiAtPiAlcycsXG4gIH0sXG4gICdtb2RlbC5kZWxldGUuYWZ0ZXIuZXJyb3InOiB7XG4gICAgbXNnOiAnRXJyb3IgaW4gYWZ0ZXJfZGVsZXRlIGxpZmVjeWNsZSBmdW5jdGlvbiAtPiAlcycsXG4gIH0sXG59O1xuXG5jb25zdCBFUlJfTkFNRV9QUkVGSVggPSAnYXBvbGxvJztcblxuY29uc3QgYnVpbGRFcnJvciA9IGZ1bmN0aW9uIGYoLi4uYXJncykge1xuICBjb25zdCBhcmdzYXJyYXkgPSBhcmdzO1xuICBjb25zdCBuYW1lID0gYXJnc2FycmF5Lmxlbmd0aCA/IGFyZ3NhcnJheS5zaGlmdCgpIDogJ19ub25lX2dpdmVuXyc7XG5cbiAgY29uc3QgZXJyb3JUZW1wbGF0ZSA9IEFFUlJPUl9UWVBFU1tuYW1lXSB8fCBBRVJST1JfVFlQRVMudW5zcGVjaWZpZWQ7XG4gIGNvbnN0IGVycm9yTXNnID0gYXJnc2FycmF5Lmxlbmd0aCA/XG4gICAgdXRpbC5mb3JtYXQuYXBwbHkodGhpcywgW2Vycm9yVGVtcGxhdGUubXNnXS5jb25jYXQoYXJnc2FycmF5KSkgOlxuICAgIGVycm9yVGVtcGxhdGUubXNnO1xuXG4gIGNvbnN0IGVycm9yID0gbmV3IEVycm9yKGVycm9yTXNnKTtcbiAgZXJyb3IubmFtZSA9IChFUlJfTkFNRV9QUkVGSVggPyB1dGlsLmZvcm1hdCgnJXMuJywgRVJSX05BTUVfUFJFRklYKSA6ICcnKSArIG5hbWU7XG5cbiAgcmV0dXJuIGVycm9yO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBidWlsZEVycm9yO1xuIl19