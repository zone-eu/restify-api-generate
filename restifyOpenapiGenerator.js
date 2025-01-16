'use strict';

const fs = require('fs');
const path = require('path');

const structuredCloneWrapper = typeof structuredClone === 'function' ? structuredClone : obj => JSON.parse(JSON.stringify(obj));

// ignore function and symbol types
const joiTypeToOpenApiTypeMap = {
    any: 'object',
    number: 'number',
    link: 'string',
    boolean: 'boolean',
    date: 'string',
    string: 'string',
    binary: 'string'
};

class RestifyApiGenerate {
    constructor(joi, dirname) {
        this.Joi = joi;

        this.dirname = dirname;

        if (!dirname) {
            throw Error('Pass in your __dirname as the second parameter');
        }
    }

    replaceWithRefs(reqBodyData) {
        if (reqBodyData.type === 'array') {
            const obj = reqBodyData.items;

            this.replaceWithRefs(obj);
        } else if (reqBodyData.type === 'object') {
            if (reqBodyData.objectName) {
                const objectName = reqBodyData.objectName;
                Object.keys(reqBodyData).forEach(key => {
                    if (key !== '$ref' || key !== 'description') {
                        delete reqBodyData[key];
                    }
                });
                reqBodyData.$ref = `#/components/schemas/${objectName}`;
            } else {
                for (const key in reqBodyData.properties) {
                    this.replaceWithRefs(reqBodyData.properties[key]);
                }
            }
        } else if (reqBodyData.type === 'alternatives') {
            for (const obj in reqBodyData.oneOf) {
                this.replaceWithRefs(obj);
            }
        }
    }

    parseComponetsDecoupled(component, components) {
        if (component.type === 'array') {
            const obj = structuredCloneWrapper(component.items); // copy

            if (obj.objectName) {
                for (const key in obj.properties) {
                    this.parseComponetsDecoupled(obj.properties[key], components);
                }

                // in case the Array itself is marked as a separate object >
                const objectName = obj.objectName;
                components[objectName] = obj;
                delete components[objectName].objectName;
                // ^
            }
        } else if (component.type === 'object') {
            const obj = structuredCloneWrapper(component); // copy
            const objectName = obj.objectName;

            for (const key in obj.properties) {
                this.parseComponetsDecoupled(obj.properties[key], components);
            }

            if (objectName) {
                components[objectName] = obj;
                delete components[objectName].objectName;
            }
        } else if (component.oneOf) {
            // Joi object is of 'alternatives' types
            for (const obj in component.oneOf) {
                this.parseComponetsDecoupled({ ...obj }, components);
            }
        }
    }

    /**
     * Parse Joi Objects
     */
    parseJoiObject(path, joiObject, requestBodyProperties) {
        if (joiObject.type === 'object') {
            const fieldsMap = joiObject._ids._byKey;

            const data = {
                type: joiObject.type,
                description: joiObject._flags.description,
                properties: {}
            };

            if (joiObject._flags.objectName) {
                data.objectName = joiObject._flags.objectName;
            }

            if (path) {
                requestBodyProperties[path] = data;
            } else if (Array.isArray(requestBodyProperties)) {
                requestBodyProperties.push(data);
            } else {
                requestBodyProperties.items = data;
            }

            for (const [key, value] of fieldsMap) {
                if (value.schema._flags.presence === 'required') {
                    if (!data.required) {
                        data.required = [];
                    }
                    data.required.push(key);
                }
                this.parseJoiObject(key, value.schema, data.properties);
            }
        } else if (joiObject.type === 'alternatives') {
            const matches = joiObject.$_terms.matches;

            const data = {
                oneOf: [],
                description: joiObject._flags.description
            };

            if (path) {
                requestBodyProperties[path] = data;
            } else if (Array.isArray(requestBodyProperties)) {
                requestBodyProperties.push(data);
            } else {
                requestBodyProperties.items = data;
            }

            for (const alternative of matches) {
                this.parseJoiObject(null, alternative.schema, data.oneOf);
            }
        } else if (joiObject.type === 'array') {
            const elems = joiObject?.$_terms.items;

            const data = {
                type: 'array',
                items: {},
                description: joiObject._flags.description
            };

            if (path) {
                requestBodyProperties[path] = data;
            } else if (Array.isArray(requestBodyProperties)) {
                requestBodyProperties.push(data);
            } else {
                requestBodyProperties.items = data;
            }
            this.parseJoiObject(null, elems[0], data);
        } else {
            const openApiType = joiTypeToOpenApiTypeMap[joiObject.type]; // even if type is object here then ignore and do not go recursive
            const description = joiObject._flags.description;
            let format = undefined;

            if (!openApiType) {
                throw new Error('Unsupported type! Check API endpoint!');
            }

            if (joiObject.type !== openApiType) {
                // type has changed, so probably string, acquire format
                format = joiObject.type;
            }

            const data = { type: openApiType, description };
            if (format) {
                data.format = format;

                if (data.format === 'date') {
                    data.format = 'date-time';
                }
            }

            // enum check
            if (joiObject._valids) {
                const enumValues = [];
                for (const validEnumValue of joiObject._valids._values) {
                    enumValues.push(validEnumValue);
                }
                if (enumValues.length > 0) {
                    data.enum = enumValues;
                }
            }

            // example check
            if (joiObject.$_terms && joiObject.$_terms.examples && joiObject.$_terms.examples.length > 0) {
                const example = joiObject.$_terms.examples[0];

                data.example = example;
            }

            // Default value for requestBody property
            if (joiObject._flags?.default !== undefined) {
                data.default = joiObject._flags.default;
            }

            if (path) {
                requestBodyProperties[path] = data;
            } else if (Array.isArray(requestBodyProperties)) {
                requestBodyProperties.push(data);
            } else {
                requestBodyProperties.items = data;
            }
        }
    }

    async generateAPiDocs(routes, options) {
        let docs = {
            openapi: options.openapiVersion || '3.0.0',
            info: options.info || {
                title: 'Example API',
                description: 'Example API docs',
                version: '1.0.0',
                contact: {
                    url: 'https://github.com/example/example'
                }
            },
            servers: options.servers || [{ url: 'https://example.com' }],
            tags: options.tags || [
                {
                    name: 'Example tag',
                    description: 'This is an example tag provided if you do not specify any tags yourself in the options'
                }
            ]
        };

        // get package version
        docs.info.version = docs.info.version || require(path.join(this.dirname, 'package.json')).version || '1.0.0'; // use provided version first, if missing means use package.json version, otherwise default to first version 1.0.0

        const mapPathToMethods = {}; // map -> {path -> {post -> {}, put -> {}, delete -> {}, get -> {}}}

        for (const routePath in routes) {
            const route = routes[routePath];
            const { spec } = route;

            // Turn `/users/:userId` into `/users/{userId}`
            spec.path = spec.path.replace(/\/:([^/]+)/g, '/{$1}');

            if (spec.excludeRoute) {
                continue;
            }

            if (!mapPathToMethods[spec.path]) {
                mapPathToMethods[spec.path] = {};
            }

            mapPathToMethods[spec.path][spec.method.toLowerCase()] = {};
            const operationObj = mapPathToMethods[spec.path][spec.method.toLowerCase()];
            // 1) add tags
            operationObj.tags = spec.tags;

            // 2) add summary
            operationObj.summary = spec.summary;

            // 3) add description
            operationObj.description = spec.description;

            // 4) add operationId
            operationObj.operationId = spec.name || route.name;

            // 5) add requestBody
            const applicationType = spec.applicationType || 'application/json';

            if (spec.validationObjs?.requestBody && Object.keys(spec.validationObjs.requestBody).length > 0) {
                operationObj.requestBody = {
                    content: {
                        [applicationType]: {
                            schema: {}
                        }
                    },
                    required: true
                };

                // convert to Joi object for easier parsing
                this.parseJoiObject('schema', this.Joi.object(spec.validationObjs?.requestBody), operationObj.requestBody.content[applicationType]);
            }

            // 6) add parameters (queryParams and pathParams).
            operationObj.parameters = [];

            for (const paramKey in spec.validationObjs?.pathParams) {
                const paramKeyData = spec.validationObjs.pathParams[paramKey];

                const obj = {};
                obj.name = paramKey;
                obj.in = 'path';

                const { description, presence, default: defaultValue } = paramKeyData._flags;

                obj.description = description;
                obj.required = presence === 'required';

                const parsedJoi = {};
                this.parseJoiObject(null, paramKeyData, parsedJoi);
                const { type, format, example, oneOf } = parsedJoi.items || {};

                obj.example = example;
                obj.schema = { type, format, oneOf };
                obj.schema.default = defaultValue;

                // enum check
                if (paramKeyData._valids) {
                    const enumValues = [];
                    for (const validEnumValue of paramKeyData._valids._values) {
                        enumValues.push(validEnumValue);
                    }
                    if (enumValues.length > 0) {
                        obj.schema.enum = enumValues;
                    }
                }

                // example check
                if (paramKeyData.$_terms && paramKeyData.$_terms.examples && paramKeyData.$_terms.examples.length > 0) {
                    const example = paramKeyData.$_terms.examples[0];

                    obj.schema.example = example;
                }

                operationObj.parameters.push(obj);
            }

            for (const paramKey in spec.validationObjs?.queryParams) {
                const paramKeyData = spec.validationObjs.queryParams[paramKey];

                const obj = {};
                obj.name = paramKey;
                obj.in = 'query';

                const { description, presence, default: defaultValue } = paramKeyData._flags;

                obj.description = description;
                obj.required = presence === 'required';

                const parsedJoi = {};
                this.parseJoiObject(null, paramKeyData, parsedJoi);
                const { type, format, example, oneOf } = parsedJoi.items || {};

                obj.example = example;
                obj.schema = { type, format, oneOf };
                obj.schema.default = defaultValue;

                // enum check
                if (paramKeyData._valids) {
                    const enumValues = [];
                    for (const validEnumValue of paramKeyData._valids._values) {
                        enumValues.push(validEnumValue);
                    }
                    if (enumValues.length > 0) {
                        obj.schema.enum = enumValues;
                    }
                }

                // example check
                if (paramKeyData.$_terms && paramKeyData.$_terms.examples && paramKeyData.$_terms.examples.length > 0) {
                    const example = paramKeyData.$_terms.examples[0];

                    obj.schema.example = example;
                }

                operationObj.parameters.push(obj);
            }

            // 7) add responses
            const responseType = spec.responseType || 'application/json';
            operationObj.responses = {};

            for (const resHttpCode in spec.validationObjs?.response) {
                const resBodyData = spec.validationObjs.response[resHttpCode];

                operationObj.responses[resHttpCode] = {
                    description: resBodyData.description,
                    content: {
                        [responseType]: {
                            schema: {}
                        }
                    }
                };

                const obj = operationObj.responses[resHttpCode];

                this.parseJoiObject('schema', resBodyData.model, obj.content[responseType]);
            }
        }

        const components = { components: { schemas: {} } };

        for (const path in mapPathToMethods) {
            // for every path
            const pathData = mapPathToMethods[path];

            for (const httpMethod in pathData) {
                // for every http method (post, put, get, delete)
                const innerData = pathData[httpMethod];

                // for every requestBody obj
                for (const key in innerData?.requestBody?.content[Object.keys(innerData.requestBody.content)[0]].schema.properties) {
                    const reqBodyData = innerData.requestBody.content[Object.keys(innerData.requestBody.content)[0]].schema.properties[key];

                    this.parseComponetsDecoupled(reqBodyData, components.components.schemas);
                    this.replaceWithRefs(reqBodyData);
                }

                // for every response object
                for (const key in innerData.responses) {
                    // key here is http method (2xx, 4xx, 5xx)
                    const obj = innerData.responses[key].content[Object.keys(innerData.responses[key].content)[0]].schema;
                    this.parseComponetsDecoupled(obj, components.components.schemas);
                    this.replaceWithRefs(obj);
                }
            }
        }

        // refify components that use other components
        for (const obj of Object.values(components.components.schemas)) {
            this.replaceWithRefs(obj);
        }

        const finalObj = { paths: mapPathToMethods };

        components.components.securitySchemes = options.components.securitySchemes;

        docs = { ...docs, ...finalObj };
        docs = { ...docs, ...components };

        docs = {
            ...docs,
            security: options.security
        };

        await fs.promises.writeFile(this.dirname + options.docsPath || '/openapidocs.json', JSON.stringify(docs, undefined, 4));
    }

    restifyApiGenerate(ctx, options) {
        const routes = ctx.router.getRoutes();

        this.generateAPiDocs(routes, options);

        return (req, res, next) => next();
    }
}

module.exports = { RestifyApiGenerate };
