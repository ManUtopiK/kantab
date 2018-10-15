/*
 * moleculer-database
 * Copyright (c) 2017 MoleculerJS (https://github.com/moleculerjs/database)
 * MIT Licensed
 */

"use strict";

const _ = require("lodash");
const Promise = require("bluebird");
const { MoleculerClientError, ValidationError, ServiceSchemaError } = require("moleculer").Errors;

const EntityNotFoundError = require("moleculer-db").EntityNotFoundError;
const MemoryAdapter = require("moleculer-db").MemoryAdapter;

/**
 * Service mixin to access database entities
 *
 * TODO:
 * 	- [ ] enhanced `fields` with visibility, default value...etc
 * 			{ name: "_id", id: true, type: "string", writable: false }, // Can't set by user
 * 			{ name: "title", type: "string", trim: true },	// Sanitization
 * 			{ name: "slug", set: (value, entity, ctx) => slug(entity.title) }	// Custom formatter
 * 			{ name: "fullName", get: (value, entity, ctx) => entity.firstName + ' ' + entity.lastName }	// Custom formatter
 * 			{ name: "password", type: "string", hidden: true, validate: (value, entity, ctx) => value.length > 6 },	// Validation
 * 			{ name: "status", type: "Number", optional: true, default: 1 } // Optional field with default value
 * 			{ name: "createdAt", type: "Date", default: Date.now },	// Default value with custom function
 * 			{ name: "updatedAt", type: "Date", default: () => new Date() }, // -||-
 * 			{ name: "roles", type: "Array", permissions: ["administrator", "$owner"] } // Visibility by permissions
 * 			{ name: "members", type: "Array", populate: "v1.accounts.populate" readPermissions: ["$owner"] }
 *
 * 	- [ ] review populates
 * 	- [ ] review transform
 * 	- [ ] rewrite `get` action. Rename to `resolve` and write a simple `get` action.
 * 	- [ ] add `create`, `find` ...etc methods in order to create new actions easily
 * 	- [ ] tenant handling https://github.com/moleculerjs/moleculer-db/pull/5
 * 	- [ ] monorepo with adapters
 * 	- [ ] multi collections in a service
 * 	- [ ] useTimestamps option.
 * 	- [ ] softDelete option with `deletedAt`
 * 	- [ ] fillable settings. Milyen mezők jöhetnek a usertől. Pl ne tudjon belementeni más role-t. De lehet permission-höz kéne kötni, mert admin felületen admin user menthet.
 *
 * @name moleculer-database
 * @module Service
 */
module.exports = function(adapter, opts) {
	opts = _.defaultsDeep(opts, {
		createActions: true,
		autoReconnect: true
	});

	const schema = {
		// Must overwrite it
		name: "",

		/**
		 * Default settings
		 */
		settings: {
			/** @type {String} Name of ID field. */
			idField: "_id",

			/** @type {Array<String>?} Field filtering list. It must be an `Array`. If the value is `null` or `undefined` doesn't filter the fields of entities. */
			fields: null,

			/** @type {Array?} Schema for population. [Read more](#populating). */
			populates: null,

			/** @type {Number} Default page size in `list` action. */
			pageSize: 10,

			/** @type {Number} Maximum page size in `list` action. */
			maxPageSize: 100,

			/** @type {Number} Maximum value of limit in `find` action. Default: `-1` (no limit) */
			maxLimit: -1,

			/** @type {Object|Function} Validator schema or a function to validate the incoming entity in `create` & 'insert' actions. */
			entityValidator: null,

			/** @type {Boolean} Soft delete mode. If true, doesn't remove the entity, just set the `deletedAt` field. */
			softDelete: false,

			/** @type {Boolean} Defined & use `createAt` and `updatedAt` fields in entity */
			useTimestamps: false,


		},

		/**
		 * Actions
		 */
		actions: {
			// Empty
		}
	};

	if (opts.createActions === true || opts.createActions.find === true) {
		/**
		 * Find entities by query.
		 *
		 * @actions
		 * @cached
		 *
		 * @param {Array<String>?} populate - Populated fields.
		 * @param {Array<String>?} fields - Fields filter.
		 * @param {Number} limit - Max count of rows.
		 * @param {Number} offset - Count of skipped rows.
		 * @param {String} sort - Sorted fields.
		 * @param {String} search - Search text.
		 * @param {String} searchFields - Fields for searching.
		 * @param {Object} query - Query object. Passes to adapter.
		 *
		 * @returns {Array<Object>} List of found entities.
		 */
		schema.actions.find = {
			cache: {
				keys: ["populate", "fields", "limit", "offset", "sort", "search", "searchFields", "query"]
			},
			params: {
				populate: { type: "array", optional: true, items: "string" },
				fields: { type: "array", optional: true, items: "string" },
				limit: { type: "number", integer: true, min: 0, optional: true, convert: true },
				offset: { type: "number", integer: true, min: 0, optional: true, convert: true },
				sort: { type: "string", optional: true },
				search: { type: "string", optional: true },
				searchFields: { type: "array", optional: true },
				query: { type: "object", optional: true }
			},
			handler(ctx) {
				let params = this.sanitizeParams(ctx, ctx.params);

				return this.adapter.find(params)
					.then(docs => this.transformDocuments(ctx, params, docs));

			}
		};
	}

	if (opts.createActions === true || opts.createActions.count === true) {
		/**
		 * Get count of entities by query.
		 *
		 * @actions
		 * @cached
		 *
		 * @param {String} search - Search text.
		 * @param {String} searchFields - Fields list for searching.
		 * @param {Object} query - Query object. Passes to adapter.
		 *
		 * @returns {Number} Count of found entities.
		 */
		schema.actions.count = {
			cache: {
				keys: ["search", "searchFields", "query"]
			},
			params: {
				search: { type: "string", optional: true },
				searchFields: { type: "array", optional: true },
				query: { type: "object", optional: true }
			},
			handler(ctx) {
				let params = this.sanitizeParams(ctx, ctx.params);

				// Remove pagination params
				if (params && params.limit)
					params.limit = null;
				if (params && params.offset)
					params.offset = null;

				return this.adapter.count(params);
			}
		};
	}

	if (opts.createActions === true || opts.createActions.list === true) {
		/**
		 * List entities by filters and pagination results.
		 *
		 * @actions
		 * @cached
		 *
		 * @param {Array<String>?} populate - Populated fields.
		 * @param {Array<String>?} fields - Fields filter.
		 * @param {Number} page - Page number.
		 * @param {Number} pageSize - Size of a page.
		 * @param {String} sort - Sorted fields.
		 * @param {String} search - Search text.
		 * @param {String} searchFields - Fields for searching.
		 * @param {Object} query - Query object. Passes to adapter.
		 *
		 * @returns {Object} List of found entities and count.
		 */
		schema.actions.list = {
			cache: {
				keys: ["populate", "fields", "page", "pageSize", "sort", "search", "searchFields", "query"]
			},
			params: {
				populate: { type: "array", optional: true, items: "string" },
				fields: { type: "array", optional: true, items: "string" },
				page: { type: "number", integer: true, min: 1, optional: true, convert: true },
				pageSize: { type: "number", integer: true, min: 0, optional: true, convert: true },
				sort: { type: "string", optional: true },
				search: { type: "string", optional: true },
				searchFields: { type: "array", optional: true },
				query: { type: "object", optional: true }
			},
			handler(ctx) {
				let params = this.sanitizeParams(ctx, ctx.params);

				let countParams = Object.assign({}, params);
				// Remove pagination params
				if (countParams && countParams.limit)
					countParams.limit = null;
				if (countParams && countParams.offset)
					countParams.offset = null;


				return Promise.all([
				// Get rows
					this.adapter.find(params),

					// Get count of all rows
					this.adapter.count(countParams)
				]).then(res => {
					return this.transformDocuments(ctx, params, res[0])
						.then(docs => {
							return {
							// Rows
								rows: docs,
								// Total rows
								total: res[1],
								// Page
								page: params.page,
								// Page size
								pageSize: params.pageSize,
								// Total pages
								totalPages: Math.floor((res[1] + params.pageSize - 1) / params.pageSize)
							};
						});
				});
			}
		};
	}

	if (opts.createActions === true || opts.createActions.create === true) {
		/**
		 * Create a new entity.
		 *
		 * @actions
		 *
		 * @returns {Object} Saved entity.
		 */
		schema.actions.create = {
			handler(ctx) {
				let entity = ctx.params;

				return this.validateEntity(entity)
					.then(entity => this.adapter.insert(entity))
					.then(doc => this.transformDocuments(ctx, {}, doc))
					.then(json => this.entityChanged("created", json, ctx).then(() => json));

			}
		};
	}

	if (opts.createActions === true || opts.createActions.insert === true) {
		/**
		 * Create many new entities.
		 *
		 * @actions
		 *
		 * @param {Object?} entity - Entity to save.
		 * @param {Array.<Object>?} entities - Entities to save.
		 *
		 * @returns {Object|Array.<Object>} Saved entity(ies).
		 */
		schema.actions.insert = {
			params: {
				entity: { type: "object", optional: true },
				entities: { type: "array", optional: true }
			},
			handler(ctx) {
				let params = this.sanitizeParams(ctx, ctx.params);

				return Promise.resolve()
					.then(() => {
						if (Array.isArray(params.entities)) {
							return this.validateEntity(params.entities)
								.then(entities => this.adapter.insertMany(entities));
						} else if (params.entity) {
							return this.validateEntity(params.entity)
								.then(entity => this.adapter.insert(entity));
						}
						return Promise.reject(new MoleculerClientError("Invalid request! The 'params' must contain 'entity' or 'entities'!", 400));
					})
					.then(docs => this.transformDocuments(ctx, params, docs))
					.then(json => this.entityChanged("created", json, ctx).then(() => json));
			}
		};
	}

	if (opts.createActions === true || opts.createActions.get === true) {
		/**
		 * Get entity by ID.
		 *
		 * @actions
		 * @cached
		 *
		 * @param {any|Array<any>} id - ID(s) of entity.
		 * @param {Array<String>?} populate - Field list for populate.
		 * @param {Array<String>?} fields - Fields filter.
		 * @param {Boolean?} mapping - Convert the returned `Array` to `Object` where the key is the value of `id`.
		 *
		 * @returns {Object|Array<Object>} Found entity(ies).
		 *
		 * @throws {EntityNotFoundError} - 404 Entity not found
		 */
		schema.actions.get = {
			cache: {
				keys: ["id", "populate", "fields", "mapping"]
			},
			params: {
				id: [
					{ type: "string" },
					{ type: "number" },
					{ type: "array" }
				],
				populate: { type: "array", optional: true, items: "string" },
				fields: { type: "array", optional: true, items: "string" },
				mapping: { type: "boolean", optional: true }
			},
			handler(ctx) {
				let params = this.sanitizeParams(ctx, ctx.params);
				let id = params.id;

				let origDoc;
				return this.getById(id, true)
					.then(doc => {
						if (!doc)
							return Promise.reject(new EntityNotFoundError(id));

						origDoc = doc;
						return this.transformDocuments(ctx, ctx.params, doc);
					})

					.then(json => {
						if (_.isArray(json) && params.mapping === true) {
							let res = {};
							json.forEach((doc, i) => {
								const id = origDoc[i][this.settings.idField];
								res[id] = doc;
							});

							return res;
						}
						return json;
					});

			}
		};
	}

	if (opts.createActions === true || opts.createActions.update === true) {
		/**
		 * Update an entity by ID.
		 * > After update, clear the cache & call lifecycle events.
		 *
		 * @actions
		 *
		 * @returns {Object} Updated entity.
		 *
		 * @throws {EntityNotFoundError} - 404 Entity not found
		 */
		schema.actions.update = {
			handler(ctx) {
				let id;
				let sets = {};

				// Convert fields from params to "$set" update object
				Object.keys(ctx.params).forEach(prop => {
					if (prop == "id" || prop == this.settings.idField)
						id = this.decodeID(ctx.params[prop]);
					else
						sets[prop] = ctx.params[prop];
				});

				return this.adapter.updateById(id, { "$set": sets })
					.then(doc => {
						if (!doc)
							return Promise.reject(new EntityNotFoundError(id));

						return this.transformDocuments(ctx, ctx.params, doc)
							.then(json => this.entityChanged("updated", json, ctx).then(() => json));
					});

			}
		};
	}

	if (opts.createActions === true || opts.createActions.remove === true) {
		/**
		 * Remove an entity by ID.
		 *
		 * @actions
		 *
		 * @param {any} id - ID of entity.
		 * @returns {Number} Count of removed entities.
		 *
		 * @throws {EntityNotFoundError} - 404 Entity not found
		 */
		schema.actions.remove = {
			params: {
				id: { type: "any" }
			},
			handler(ctx) {
				let params = this.sanitizeParams(ctx, ctx.params);
				const id = this.decodeID(params.id);

				return this.adapter.removeById(id)
					.then(doc => {
						if (!doc)
							return Promise.reject(new EntityNotFoundError(params.id));

						return this.transformDocuments(ctx, params, doc)
							.then(json => this.entityChanged("removed", json, ctx).then(() => json));
					});

			}
		};
	}

	/**
	 * Methods
	 */
	schema.methods = {

		/**
		 * Connect to database.
		 */
		connect() {
			return this.adapter.connect().then(() => {
			// Call an 'afterConnected' handler in schema
				if (_.isFunction(this.schema.afterConnected)) {
					try {
						return this.schema.afterConnected.call(this);
					} catch(err) {
					/* istanbul ignore next */
						this.logger.error("afterConnected error!", err);
					}
				}
			});
		},

		/**
		 * Disconnect from database.
		 */
		disconnect() {
			if (_.isFunction(this.adapter.disconnect))
				return this.adapter.disconnect();
		},

		/**
		 * Sanitize context parameters at `find` action.
		 *
		 * @param {Context} ctx
		 * @param {any} origParams
		 * @returns {Promise}
		 */
		sanitizeParams(ctx, params) {
			let p = Object.assign({}, params);

			// Convert from string to number
			if (typeof(p.limit) === "string")
				p.limit = Number(p.limit);
			if (typeof(p.offset) === "string")
				p.offset = Number(p.offset);
			if (typeof(p.page) === "string")
				p.page = Number(p.page);
			if (typeof(p.pageSize) === "string")
				p.pageSize = Number(p.pageSize);

			if (typeof(p.sort) === "string")
				p.sort = p.sort.replace(/,/, " ").split(" ");

			if (typeof(p.fields) === "string")
				p.fields = p.fields.replace(/,/, " ").split(" ");

			if (typeof(p.populate) === "string")
				p.populate = p.populate.replace(/,/, " ").split(" ");

			if (ctx.action.name.endsWith(".list")) {
				// Default `pageSize`
				if (!p.pageSize)
					p.pageSize = this.settings.pageSize;

				// Default `page`
				if (!p.page)
					p.page = 1;

				// Limit the `pageSize`
				if (this.settings.maxPageSize > 0 && p.pageSize > this.settings.maxPageSize)
					p.pageSize = this.settings.maxPageSize;

				// Calculate the limit & offset from page & pageSize
				p.limit = p.pageSize;
				p.offset = (p.page - 1) * p.pageSize;
			}
			// Limit the `limit`
			if (this.settings.maxLimit > 0 && p.limit > this.settings.maxLimit)
				p.limit = this.settings.maxLimit;

			return p;
		},

		/**
		 * Get entity(ies) by ID(s).
		 *
		 * @methods
		 * @param {String|Number|Array} id - ID or IDs.
		 * @param {Boolean} decoding - Need to decode IDs.
		 * @returns {Object|Array<Object>} Found entity(ies).
		 */
		getById(id, decoding) {
			return Promise.resolve()
				.then(() => {
					if (_.isArray(id)) {
						return this.adapter.findByIds(decoding ? id.map(this.decodeID) : id);
					} else {
						return this.adapter.findById(decoding ? id.map(this.decodeID) : id);
					}
				});
		},

		/**
		 * Clear the cache & call entity lifecycle events
		 *
		 * @param {String} type
		 * @param {Object|Array|Number} json
		 * @param {Context} ctx
		 * @returns {Promise}
		 */
		entityChanged(type, json, ctx) {
			return this.clearCache().then(() => {
				const eventName = `entity${_.capitalize(type)}`;
				if (this.schema[eventName] != null) {
					return this.schema[eventName].call(this, json, ctx);
				}
			});
		},

		/**
		 * Clear cached entities
		 *
		 * @methods
		 * @returns {Promise}
		 */
		clearCache() {
			this.broker.broadcast(`cache.clean.${this.name}`);
			if (this.broker.cacher)
				this.broker.cacher.clean(`${this.name}.*`);
			return Promise.resolve();
		},

		/**
		 * Transform the fetched documents
		 *
		 * @param {Array|Object} 	docs
		 * @param {Object} 			Params
		 * @returns {Array|Object}
		 */
		transformDocuments(ctx, params, docs) {
			let isDoc = false;
			if (!Array.isArray(docs)) {
				if (_.isObject(docs)) {
					isDoc = true;
					docs = [docs];
				}
				else
					return Promise.resolve(docs);
			}

			return Promise.resolve(docs)

				// Convert entity to JS object
				.then(docs => docs.map(doc => this.adapter.entityToObject(doc)))

				// Encode IDs
				.then(docs => docs.map(doc => {
					doc[this.settings.idField] = this.encodeID(doc[this.settings.idField]);
					return doc;
				}))

				// Populate
				.then(json => (ctx && params.populate) ? this.populateDocs(ctx, json, params.populate) : json)

			// TODO onTransformHook

				// Filter fields
				.then(json => {
					let fields = ctx && params.fields ? params.fields : this.settings.fields;

					// Authorize the requested fields
					const authFields = this.authorizeFields(fields);

					return json.map(item => this.filterFields(item, authFields));
				})

				// Return
				.then(json => isDoc ? json[0] : json);
		},

		/**
		 * Filter fields in the entity object
		 *
		 * @param {Object} 	doc
		 * @param {Array} 	fields	Filter properties of model.
		 * @returns	{Object}
		 */
		filterFields(doc, fields) {
			// Apply field filter (support nested paths)
			if (Array.isArray(fields)) {
				let res = {};
				fields.forEach(n => {
					const v = _.get(doc, n);
					if (v !== undefined)
						_.set(res, n, v);
				});
				return res;
			}

			return doc;
		},

		/**
		 * Authorize the required field list. Remove fields which is not exist in the `this.settings.fields`
		 *
		 * @param {Array} fields
		 * @returns {Array}
		 */
		authorizeFields(fields) {
			if (this.settings.fields && this.settings.fields.length > 0) {
				let res = [];
				if (Array.isArray(fields) && fields.length > 0) {
					fields.forEach(f => {
						if (this.settings.fields.indexOf(f) !== -1) {
							res.push(f);
							return;
						}

						if (f.indexOf(".") !== -1) {
							let parts = f.split(".");
							while (parts.length > 1) {
								parts.pop();
								if (this.settings.fields.indexOf(parts.join(".")) !== -1) {
									res.push(f);
									break;
								}
							}
						}

						let nestedFields = this.settings.fields.filter(prop => prop.indexOf(f + ".") !== -1);
						if (nestedFields.length > 0) {
							res = res.concat(nestedFields);
						}
					});
				}
				return res;
			}

			return fields;
		},

		/**
		 * Populate documents.
		 *
		 * @param {Context} 		ctx
		 * @param {Array|Object} 	docs
		 * @param {Array}			populateFields
		 * @returns	{Promise}
		 */
		populateDocs(ctx, docs, populateFields) {
			if (!this.settings.populates || !Array.isArray(populateFields) || populateFields.length == 0)
				return Promise.resolve(docs);

			if (docs == null || !_.isObject(docs) || !Array.isArray(docs))
				return Promise.resolve(docs);

			let promises = [];
			_.forIn(this.settings.populates, (rule, field) => {

				if (populateFields.indexOf(field) === -1)
					return; // skip

				// if the rule is a function, save as a custom handler
				if (_.isFunction(rule)) {
					rule = {
						handler: Promise.method(rule)
					};
				}

				// If string, convert to object
				if (_.isString(rule)) {
					rule = {
						action: rule
					};
				}
				rule.field = field;

				let arr = Array.isArray(docs) ? docs : [docs];

				// Collect IDs from field of docs (flatten, compact & unique list)
				let idList = _.uniq(_.flattenDeep(_.compact(arr.map(doc => doc[field]))));
				// Replace the received models according to IDs in the original docs
				const resultTransform = (populatedDocs) => {
					arr.forEach(doc => {
						let id = doc[field];
						if (_.isArray(id)) {
							let models = _.compact(id.map(id => populatedDocs[id]));
							doc[field] = models;
						} else {
							doc[field] = populatedDocs[id];
						}
					});
				};

				if (rule.handler) {
					promises.push(rule.handler.call(this, idList, arr, rule, ctx));
				} else if (idList.length > 0) {
					// Call the target action & collect the promises
					const params = Object.assign({
						id: idList,
						mapping: true,
						populate: rule.populate
					}, rule.params || {});

					promises.push(ctx.call(rule.action, params).then(resultTransform));
				}
			});

			return Promise.all(promises).then(() => docs);
		},

		/**
		 * Validate an entity by validator.
		 *
		 * @param {any} entity
		 * @returns {Promise}
		 */
		validateEntity(entity) {
			if (!_.isFunction(this.settings.entityValidator))
				return Promise.resolve(entity);

			let entities = Array.isArray(entity) ? entity : [entity];
			return Promise.all(entities.map(entity => this.settings.entityValidator.call(this, entity))).then(() => entity);
		},

		/**
		 * Encode ID of entity.
		 *
		 * @methods
		 * @param {any} id
		 * @returns {any}
		 */
		encodeID(id) {
			return id;
		},

		/**
		 * Decode ID of entity.
		 *
		 * @methods
		 * @param {any} id
		 * @returns {any}
		 */
		decodeID(id) {
			return id;
		}
	};

	/**
	 * Service created lifecycle event handler
	 */
	schema.created = function() {
		this.adapter = adapter || new MemoryAdapter();

		this.adapter.init(this.broker, this);

		// Transform entity validation schema to checker function
		if (this.broker.validator && _.isObject(this.settings.entityValidator) && !_.isFunction(this.settings.entityValidator)) {
			const check = this.broker.validator.compile(this.settings.entityValidator);
			this.settings.entityValidator = entity => {
				const res = check(entity);
				if (res === true)
					return Promise.resolve();
				else
					return Promise.reject(new ValidationError("Entity validation error!", null, res));
			};
		}
	};

	/**
	 * Service started lifecycle event handler
	 */
	schema.started = function()  {
		if (this.adapter) {
			return new Promise(resolve => {
				let connecting = () => {
					this.connect().then(resolve).catch(err => {
						this.logger.error("Connection error!", err);
						if (opts.autoReconnect) {
							setTimeout(() => {
								this.logger.warn("Reconnecting...");
								connecting();
							}, 1000);
						}
					});
				};

				connecting();
			});
		}

		/* istanbul ignore next */
		return Promise.reject(new ServiceSchemaError("Please configure a database adapter!"));
	};

	/**
	 * Service stopped lifecycle event handler
	 */
	schema.stopped = function() {
		if (this.adapter)
			return this.disconnect();
	};

	// Export Memory Adapter class
	schema.MemoryAdapter = MemoryAdapter;

	return schema;
};
