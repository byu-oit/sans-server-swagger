/**
 *  @license
 *    Copyright 2016 Brigham Young University
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 **/
'use strict';
const normalize         = require('./normalize');
const is                = require('./is');

exports.request = function(req, schema, definitions) {
    const errors = [];
    const queryParams = {};

    // validate that inputs match schema
    if (Array.isArray(schema.parameters)) {
        schema.parameters.forEach(param => {
            const name = param.name;
            const store = (function(key) {
                switch (key) {
                    case 'body':
                        const o = {};
                        if (typeof req.body !== 'undefined') o[name] = req.body;
                        return o;
                    case 'formData':
                        return req.body;
                        break;
                    case 'header': return req.headers;
                    case 'path': return req.params;
                    case 'query':
                        queryParams[name] = true;
                        return req.query;
                }
            })(param.in);
            if (param.in === 'path') param.required = true;

            // check if required and not present
            if (param.required && (!store || !store.hasOwnProperty(name))) {
                errors.push('Missing required ' + (param.in === 'body' ? 'body payload.' : param.in + ' parameter: ' + name));
                return;
            }

            // get the value and validate it
            if (store.hasOwnProperty(name)) {
                const value = store[name];
                const schema = param.in === 'body' ? param.schema : param;
                const err = exports.byType(value, schema, definitions, 2);
                if (err) errors.push('Error in ' + param.in + (param.in === 'body' ? '' : ' for parameter: ' + name) + '. ' + err.replace(/^\s+/, ''));
            }
        });
    }

    // validate that all query parameters are allowed
    Object.keys(req.query)
        .forEach(key => {
            if (!queryParams[key]) errors.push('Use of query parameter not allowed: ' + key);
        });

    if (errors.length > 0) return 'Request invalid due to one or more errors:\n  ' + errors.join('\n  ');
};

exports.response = function(value, schema, definitions, depth) {
    const err = exports.byType(value, schema, definitions, depth);
    if (err) return 'Response did not meet swagger requirements:\n' + err;
};






exports.array = function(value, schema, definitions, depth) {
    const error = errorGen(value, depth);
    if (!is.array(value)) return error('Expected an array.');

    const length = value.length;
    if (schema.hasOwnProperty('maxItems') && length > schema.maxItems) return error('Expected an array with maximum length of ' + schema.maxItems + '.', 'Received: ' + value + ' (' + length + ')');
    if (schema.hasOwnProperty('minItems') && length > schema.minItems) return error('Expected an array with minimum length of ' + schema.maxItems + '.', 'Received: ' + value + ' (' + length + ')');

    const uniqueMap = schema.uniqueItems ? new Map() : null;
    const errors = value
        .map((item, index) => {
            if (uniqueMap && uniqueMap.has(item)) return error('Expected an array of unique items.', 'Value is not unique: ' + item);
            if (uniqueMap) uniqueMap.set(item, true);
            if (schema.items) {
                const err = exports.byType(item, schema.items, definitions, (depth || 0) + 2);
                if (err) return error.spaces + 'Error at index ' + index + ': ' + err.replace(/^\s+/, '');
            }
        })
        .filter(v => v);
    if (errors.length > 0) return error.spaces + 'Array had multiple errors: \n  ' + errors.join('\n  ');
    return '';
};

exports.binary = function(value, schema, definitions, depth) {
    const error = errorGen(value, depth);
    if (!normalize.rxBinary.test(value) || value.length % 8 !== 0) return error('Expected a binary sequence of octets.');
    return generic(value, schema, definitions, depth);
};

exports.byte = function(value, schema, definitions, depth) {
    const error = errorGen(value, depth);
    if (!normalize.rxBase64.test(value)) return error('Expected a base64 encoded value.');
    return generic(value, schema, definitions, depth);
};

exports.byType = function(value, schema, definitions, depth) {
    const type = normalize.schemaType(schema);
    switch (type) {
        case 'array': return exports.array(value, schema, definitions, depth);
        case 'boolean': return;
        case 'file': return;
        case 'integer': return exports.integer(value, schema, definitions, depth);
        case 'number': return exports.number(value, schema, definitions, depth);
        case 'object': return exports.object(value, schema, definitions, depth);
        case 'string':
            if (!schema.hasOwnProperty('format')) return exports.string(value, schema, definitions, depth);
            switch (schema.format) {
                case 'binary': return exports.binary(value, schema, definitions, depth);
                case 'byte': return exports.byte(value, schema, definitions, depth);
                case 'date': return exports.date(value, schema, definitions, depth);
                case 'date-time': return exports.dateTime(value, schema, definitions, depth);
                default: return exports.string(value, schema, definitions, depth);
            }
            break;
    }
    return '';
};

exports.date = function(value, schema, definitions, depth) {
    const error = errorGen(value, depth);
    if (typeof value === 'string') {
        const match = normalize.rxDate.exec(value);
        if (!match) return error('Expected a date (YYYY-MM-DD).');

        const year = +match[1];
        const month = +match[2] - 1;
        const day = +match[3];
        const date = new Date(year, month, day);
        if (date.getFullYear() !== year || date.getMonth() !== month || date.getDay() !== day) return error('Date does not exist on the calendar.');

        return exports.dateTime(value + 'T00:00:00Z', schema, definitions, depth);

    } else if (is.dateObject(value)) {
        const date = normalize.startOfDay(value);
        return exports.dateTime(date, schema, definitions, depth);

    } else {
        return error('Expected a date.');
    }
};

exports.dateTime = function(value, schema, definitions, depth) {
    const error = errorGen(value, depth);
    const isDate = is.dateObject(value);

    if (typeof value === 'string') {
        const match = normalize.rxTime.exec(value);
        if (!match) return error('Expected a date-time (YYYY-MM-DDTHH:mm:SSZ).');

        const hour = +match[4];
        const minute = +match[5];
        const second = +match[6];

        if (hour > 23) return error('Date-time hour outside of expected range. Must be between 00 and 23.', 'Received: ' + hour);
        if (minute > 59) return error('Date-time minute outside of expected range. Must be between 00 and 59.', 'Received: ' + minute);
        if (second > 59) return error('Date-time second outside of expected range. Must be between 00 and 59.', 'Received: ' + second);

    } else if (!isDate) {
        if (!match) return error('Expected a date.');
    }

    const numeric = isDate ? +value : +normalize.toDate(value);
    const numericSchema = Object.assign({}, schema);
    if (schema.hasOwnProperty('maximum')) numericSchema.maximum = +normalize.toDate(schema.maximum);
    if (schema.hasOwnProperty('minimum')) numericSchema.minimum = +normalize.toDate(schema.minimum);
    return exports.number(numeric, numericSchema, definitions, depth);
};

exports.integer = function(value, schema, definitions, depth) {
    const error = errorGen(value, depth);
    if (!is.number(value) || !normalize.rxInteger.test(value)) return error('Expected an integer.');
    return exports.number(value, schema, definitions, depth);
};

exports.number = function(value, schema, definitions, depth) {
    const error = errorGen(value, depth);
    if (!is.number(value) || !normalize.rxNumber.test(value)) return error('Expected a number.');

    if (schema.hasOwnProperty('multipleOf') && value % schema.multipleOf !== 0) return error('Expected the number be to a multiple of ' + schema.multipleOf + '.');
    if (schema.hasOwnProperty('maximum') && value > schema.maximum) return error('Expected the number to be less than or equal to ' + schema.maximum + '.');
    if (schema.hasOwnProperty('maximum') && schema.exclusiveMaximum && value >= schema.maximum) return error('Expected the number to be less than ' + schema.maximum + '.');
    if (schema.hasOwnProperty('minimum') && value < schema.minimum) return error('Expected the number to be greater than or equal to ' + schema.minimum + '.');
    if (schema.hasOwnProperty('minimum') && schema.exclusiveMinimum && value <= schema.minimum) return error('Expected the number to be greater than ' + schema.maximum + '.');

    return generic(value, schema, definitions, depth);
};

exports.object = function(value, schema, definitions, depth) {
    const error = errorGen(value, depth);
    const isObject = typeof value === 'object';

    // validate inheritances
    if (value && isObject && (schema.allOf || schema.discriminator)) {
        const errors = validateInheritances(value, schema, definitions, depth);
        if (errors.length > 0) return error.spaces + 'Object had one or more errors: \n' + errors.join('\n' + error.spaces + '  ');
    } else if (isObject) {
        return plainObject(value, schema, definitions, depth);
    }
};

exports.string = function(value, schema, definitions, depth) {
    const error = errorGen(value, depth);
    if (typeof value !== 'string') return error('Expected a string.');

    if (schema.hasOwnProperty('maxLength') && value.length > schema.maxLength) return error('Expected a string with maximum length of ' + schema.maxLength + '.', 'Received: ' + value + ' (' + value.length + ')');
    if (schema.hasOwnProperty('minLength') && value.length < schema.minLength) return error('Expected a string with minimum length of ' + schema.minLength + '.', 'Received: ' + value + ' (' + value.length + ')');
    if (schema.hasOwnProperty('pattern')) {
        const rx = new RegExp(schema.pattern);
        if (!rx.test(value)) return error('Expected string to match pattern ' + schema.pattern + '.');
    }

    return generic(value, schema, definitions, depth);
};


/**
 * Produce an error generator function.
 * @param {*} value
 * @param {number} depth
 * @returns {Function}
 */
function errorGen(value, depth) {
    if (!depth) depth = 0;
    let spaces = '';
    for (let i = 0; i < depth; i++) spaces += '  ';

    const fn = function(expected, suffix) {
        return spaces + expected + ' ' +
            (suffix ? suffix : 'Received: ' + (typeof value === 'string' ? '"' + value + '"' : value));
    };
    fn.spaces = spaces;

    return fn;
}

/**
 * Run generic validation that is applicable to all types.
 * @param {*} value
 * @param {object} schema
 * @param {object} definitions
 * @param {string} prefix
 * @returns {*}
 */
function generic(value, schema, definitions, prefix) {
    return schema.hasOwnProperty('enum') && schema.enum.indexOf(value) === -1
        ? errorGen(value, prefix)('Expected one of: ' + schema.enum.join(', ') + '.')
        : '';
}

/**
 * Validate an object (ignoring inheritances)
 * @param {*} value
 * @param {object} schema
 * @param {object} definitions
 * @param {number} depth
 * @returns {*}
 */
function plainObject(value, schema, definitions, depth) {
    const error = errorGen(value, depth);
    const keys = Object.keys(value);

    if (!is.nonNullObject(value)) return error('Expected a non-null object.');

    if (schema.hasOwnProperty('maxProperties') && length > schema.maxProperties) return error('Expected an object with a maximum of ' + schema.maxProperties + '.', 'Received: ' + keys.join(', ') + ' (' + length + ')');
    if (schema.hasOwnProperty('minProperties') && length < schema.minProperties) return error('Expected an object with a minimum of ' + schema.minProperties + '.', 'Received: ' + keys.join(', ') + ' (' + length + ')');

    const hasDefinedProperties = schema.hasOwnProperty('properties');
    const requiredProperties = hasDefinedProperties
        ? Object.keys(schema.properties)
            .filter(key => schema.properties[key].required)
            .reduce((p, c) => { p[c] = true; return p; }, {})
        : {};

    const errors = hasDefinedProperties
        ? keys.map(key => {
            if (!schema.properties.hasOwnProperty(key)) return error('Property not allowed: ', key);
            delete requiredProperties[key];
            const err = exports.byType(value[key], schema.properties[key], definitions, depth + 1);
            if (err) return error.spaces + '  Error in property "' + key + '": ' + err.replace(/^\s+/, '');
        })
            .filter(v => v)
        : [];
    if (errors.length > 0) return error.spaces + 'Object had one or more errors: \n' + errors.join('\n');

    const missingRequired = Object.keys(requiredProperties);
    if (missingRequired.length > 0) return error.spaces + 'Object missing required properties: ' + missingRequired.join(', ');

    return generic(value, schema, definitions, depth);
}

/**
 * Validate an object with composition or inheritance.
 * @param {*} value
 * @param {object} schema
 * @param {object} definitions
 * @param {number} depth
 * @returns {*}
 */
function validateInheritances(value, schema, definitions, depth) {
    const buildErrors = [];
    const map = new Map();
    const schemas = [];

    function build(schema) {
        if (!schema || typeof schema !== 'object' || map.has(schema)) return;

        const hasAllOf = Array.isArray(schema.allOf);
        const notAllOf = !hasAllOf;
        map.set(schema, notAllOf);
        if (notAllOf) schemas.push(schema);

        if (hasAllOf) {
            schema.allOf.forEach(build);

        } else if (schema.hasOwnProperty('discriminator')) {
            const discriminator = schema.discriminator;
            const name = value[discriminator];

            if (!value.hasOwnProperty(discriminator)) {
                buildErrors.push('Missing required discriminator property: ' + discriminator);
            } else if (!definitions.hasOwnProperty(name)) {
                buildErrors.push('Could not find definition "' + name + '" for discriminator: ' + discriminator);
            } else {
                const defSchema = definitions[name];
                build(defSchema);
            }
        }
    }

    build(schema);
    if (buildErrors.length > 0) return buildErrors;

    const properties = Object.keys(value);
    const unused = properties.slice(0);
    const errors = schemas
        .map(schema => {
            const schemaProperties = Object.keys(schema.properties);
            const partial = value ? normalize.partialObject(value, schemaProperties) : value;
            const error = plainObject(partial, schema, definitions, depth);
            if (error) return error;

            if (unused.length > 0) {
                Object.keys(partial)
                    .forEach(key => {
                        const index = unused.indexOf(key);
                        if (index !== -1) unused.splice(index, 1);
                    });
            }
        })
        .filter(v => !!v);

    if (unused.length > 0) {
        errors.push('One or more properties not allowed: ' + unused.join(', '));
    }

    return errors;
}