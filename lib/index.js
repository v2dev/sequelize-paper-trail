/* eslint-disable no-shadow */
import Sequelize from 'sequelize';
import cls from 'continuation-local-storage';
import * as jsdiff from 'diff';
import _ from 'lodash';
import helpers from './helpers';

let failHard = false;

exports.init = (sequelize, optionsArg) => {
	// In case that options is being parsed as a readonly attribute.
	// Or it is not passed at all
	const optsArg = _.cloneDeep(optionsArg || {});

	const defaultOptions = {
		debug: false,
		log: null,
		exclude: [
			'id',
			'createdAt',
			'updatedAt',
			'deletedAt',
			'created_at',
			'updated_at',
			'deleted_at',
			'revision',
		],
		revisionAttribute: 'revision',
		revisionModel: 'Revision',
		revisionChangeModel: 'RevisionChange',
		enableRevisionChangeModel: false,
		UUID: false,
		underscored: false,
		underscoredAttributes: false,
		defaultAttributes: {
			documentId: 'documentId',
			revisionId: 'revisionId',
		},
		userModel: false,
		userModelAttribute: 'userId',
		enableCompression: false,
		enableMigration: false,
		enableStrictDiff: true,
		continuationNamespace: null,
		continuationKey: 'userId',
		metaDataFields: null,
		metaDataContinuationKey: 'metaData',
		mysql: false,
	};

	let ns = null;
	if (optsArg.continuationNamespace) {
		ns = cls.getNamespace(optsArg.continuationNamespace);
		if (!ns) {
			ns = cls.createNamespace(optsArg.continuationNamespace);
		}
	}

	if (optsArg.underscoredAttributes) {
		helpers.toUnderscored(defaultOptions.defaultAttributes);
	}

	const options = _.defaults(optsArg, defaultOptions);

	// TODO: implement logging option
	const log = options.log || console.log;

	// Method added to handle creation of revision record of bulkCreate
	function bulkCreateBeforeHook(operation) {
		const beforeHook = function beforeHook(instance, opt) {
			if (options.debug) {
				log('bulkCreateBeforeHook called');
			}
			if (opt.noPaperTrail) {
				if (options.debug) {
					log('noPaperTrail opt: is true, not logging');
				}
				return null;
			}
			// eslint-disable-next-line no-shadow
			_.forEach(instance, instance => {
				if (options.debug) {
					log('instance:', instance);
					log('opt:', opt);
				}
				instance.set('revision', 1);
			});
			if (options.debug) {
				log('end of bulkCreateBeforeHook');
			}
			return null;
		};
		return beforeHook;
	}

	function createBeforeHook(operation) {
		const beforeHook = function beforeHook(instance, opt) {
			if (options.debug) {
				log('beforeHook called');
				log('instance:', instance);
				log('opt:', opt);
			}

			if (opt.noPaperTrail) {
				if (options.debug) {
					log('noPaperTrail opt: is true, not logging');
				}
				return;
			}

			const destroyOperation = operation === 'destroy';

			let previousVersion = {};
			let currentVersion = {};
			if (!destroyOperation && options.enableCompression) {
				_.forEach(opt.defaultFields, a => {
					previousVersion[a] = instance._previousDataValues[a];
					currentVersion[a] = instance.dataValues[a];
				});
			} else {
				previousVersion = instance._previousDataValues;
				currentVersion = instance.dataValues;
			}
			// Supported nested models.
			previousVersion = _.omitBy(
				previousVersion,
				i => i != null && typeof i === 'object' && !(i instanceof Date),
			);
			previousVersion = _.omit(previousVersion, options.exclude);

			currentVersion = _.omitBy(
				currentVersion,
				i => i != null && typeof i === 'object' && !(i instanceof Date),
			);
			currentVersion = _.omit(currentVersion, options.exclude);

			// Disallow change of revision
			instance.set(
				options.revisionAttribute,
				instance._previousDataValues[options.revisionAttribute],
			);

			// Get diffs
			const delta = helpers.calcDelta(
				previousVersion,
				currentVersion,
				options.exclude,
				options.enableStrictDiff,
			);

			const currentRevisionId = instance.get(options.revisionAttribute);

			if (failHard && !currentRevisionId && opt.type === 'UPDATE') {
				throw new Error('Revision Id was undefined');
			}

			if (options.debug) {
				log('delta:', delta);
				log('revisionId', currentRevisionId);
			}
			// Check if all required fields have been provided to the opts / CLS
			if (options.metaDataFields) {
				// get all required field keys as an array
				const requiredFields = _.keys(
					_.pickBy(
						options.metaDataFields,
						function isMetaDataFieldRequired(required) {
							return required;
						},
					),
				);
				if (requiredFields && requiredFields.length) {
					const metaData =
						(ns && ns.get(options.metaDataContinuationKey)) ||
						opt.metaData;
					const requiredFieldsProvided = _.filter(
						requiredFields,
						function isMetaDataFieldNonUndefined(field) {
							return metaData[field] !== undefined;
						},
					);
					if (
						requiredFieldsProvided.length !== requiredFields.length
					) {
						log(
							'Required fields: ',
							options.metaDataFields,
							requiredFields,
						);
						log(
							'Required fields provided: ',
							metaData,
							requiredFieldsProvided,
						);
						throw new Error(
							'Not all required fields are provided to paper trail!',
						);
					}
				}
			}

			if (destroyOperation || (delta && delta.length > 0)) {
				const revisionId = (currentRevisionId || 0) + 1;
				instance.set(options.revisionAttribute, revisionId);

				if (!instance.context) {
					instance.context = {};
				}
				instance.context.delta = delta;
			}

			if (options.debug) {
				log('end of beforeHook');
			}
		};
		return beforeHook;
	}
	// Method added to handle creation of revision record of bulkCreate

	function bulkCreateAfterHook(operation) {
		const afterHook = function afterHook(instance, opt) {
			if (options.debug) {
				log('bulkCreateAfterHook called');
			}
			if (opt.noPaperTrail) {
				if (options.debug) {
					log('noPaperTrail opt: is true, not logging');
				}
				return null;
			}
			const Revision = sequelize.model(options.revisionModel);
			_.forEach(instance, instance => {
				if (options.debug) {
					log('instance:', instance);
					log('opt:', opt);
				}
				let currentVersion = {};
				currentVersion = instance.dataValues;
				currentVersion = _.omitBy(
					currentVersion,
					i =>
						i != null &&
						typeof i === 'object' &&
						!(i instanceof Date),
				);
				currentVersion = _.omit(currentVersion, options.exclude);
				let document = currentVersion;
				if (options.mysql) {
					document = JSON.stringify(document);
				} //
				const query = {
					model: this.name,
					document,
					operation,
				};
				instance.set('revision', 1);
				query[options.userModelAttribute] = opt.userId;
				query[options.defaultAttributes.documentId] = instance.id;
				const revision = Revision.build(query);
				revision[options.revisionAttribute] = 1;
				return revision.save({
					transaction: opt.transaction,
				});
			});
			if (options.debug) {
				log('end of bulkCreateAfterHook');
			}
			return null;
		};
		return afterHook;
	}

	function createAfterHook(operation) {
		const afterHook = function afterHook(instance, opt) {
			if (options.debug) {
				log('afterHook called');
				log('instance:', instance);
				log('opt:', opt);
				if (ns) {
					log(
						`CLS ${options.continuationKey}:`,
						ns.get(options.continuationKey),
					);
				}
			}
			if (opt.noPaperTrail) {
				if (options.debug) {
					log('noPaperTrail opt: is true, not logging');
				}
				return null;
			}

			const destroyOperation = operation === 'destroy';

			if (
				instance.context &&
				((instance.context.delta &&
					instance.context.delta.length > 0) ||
					destroyOperation)
			) {
				const Revision = sequelize.model(options.revisionModel);
				let RevisionChange;

				if (options.enableRevisionChangeModel) {
					RevisionChange = sequelize.model(
						options.revisionChangeModel,
					);
				}

				const { delta } = instance.context;

				let previousVersion = {};
				let currentVersion = {};
				if (!destroyOperation && options.enableCompression) {
					_.forEach(opt.defaultFields, a => {
						previousVersion[a] = instance._previousDataValues[a];
						currentVersion[a] = instance.dataValues[a];
					});
				} else {
					previousVersion = instance._previousDataValues;
					currentVersion = instance.dataValues;
				}

				// Supported nested models.
				previousVersion = _.omitBy(
					previousVersion,
					i =>
						i != null &&
						typeof i === 'object' &&
						!(i instanceof Date),
				);
				previousVersion = _.omit(previousVersion, options.exclude);

				currentVersion = _.omitBy(
					currentVersion,
					i =>
						i != null &&
						typeof i === 'object' &&
						!(i instanceof Date),
				);
				currentVersion = _.omit(currentVersion, options.exclude);

				if (failHard && ns && !ns.get(options.continuationKey)) {
					throw new Error(
						`The CLS continuationKey ${options.continuationKey} was not defined.`,
					);
				}

				let document = currentVersion;

				if (options.mysql) {
					document = JSON.stringify(document);
				}

				// Build revision
				const query = {
					model: this.name,
					document,
					operation,
				};

				// Add all extra data fields to the query object
				if (options.metaDataFields) {
					const metaData =
						(ns && ns.get(options.metaDataContinuationKey)) ||
						opt.metaData;
					if (metaData) {
						_.forEach(
							options.metaDataFields,
							function getMetaDataValues(required, field) {
								const value = metaData[field];
								if (options.debug) {
									log(
										`Adding metaData field to Revision - ${field} => ${value}`,
									);
								}
								if (!(field in query)) {
									query[field] = value;
								} else if (options.debug) {
									log(
										`Revision object already has a value at ${field} => ${query[field]}`,
									);
									log('Not overwriting the original value');
								}
							},
						);
					}
				}

				// in case of custom user models that are not 'userId'
				query[options.userModelAttribute] =
					(ns && ns.get(options.continuationKey)) || opt.userId;

				query[options.defaultAttributes.documentId] = instance.id;

				const revision = Revision.build(query);

				revision[options.revisionAttribute] = instance.get(
					options.revisionAttribute,
				);

				// Save revision
				return revision
					.save({ transaction: opt.transaction })
					.then(objectRevision => {
						// Loop diffs and create a revision-diff for each
						if (
							options.enableRevisionChangeModel &&
							query.operation === 'update'
						) {
							_.forEach(delta, difference => {
								const o = helpers.diffToString(
									difference.item
										? difference.item.lhs
										: difference.lhs,
								);
								const n = helpers.diffToString(
									difference.item
										? difference.item.rhs
										: difference.rhs,
								);

								// let document = difference;
								document = difference;
								let diff = o || n ? jsdiff.diffChars(o, n) : [];

								if (options.mysql) {
									document = JSON.stringify(document);
									diff = JSON.stringify(diff);
								}

								const d = RevisionChange.build({
									path: difference.path[0],
									document,
									diff,
									revisionId: objectRevision.id,
								});

								d.save({ transaction: opt.transaction })
									.then(savedD => {
										// Add diff to revision
										objectRevision[
											`add${helpers.capitalizeFirstLetter(
												options.revisionChangeModel,
											)}`
										](savedD);

										return null;
									})
									.catch(err => {
										log('RevisionChange save error', err);
										throw err;
									});
							});
						}
						return null;
					})
					.catch(err => {
						log('Revision save error', err);
						throw err;
					});
			}

			if (options.debug) {
				log('end of afterHook');
			}

			return null;
		};
		return afterHook;
	}

	_.assignIn(Sequelize.Model, {
		hasPaperTrail: function hasPaperTrail() {
			if (options.debug) {
				log('Enabling paper trail on', this.name);
			}

			this.rawAttributes[options.revisionAttribute] = {
				type: Sequelize.BIGINT,
				defaultValue: 0,
			};
			this.revisionable = true;

			// not sure if we need this
			this.refreshAttributes();

			if (options.enableMigration) {
				const tableName = this.getTableName();

				const queryInterface = sequelize.getQueryInterface();

				queryInterface.describeTable(tableName).then(attributes => {
					if (!attributes[options.revisionAttribute]) {
						if (options.debug) {
							log('adding revision attribute to the database');
						}

						queryInterface
							.addColumn(tableName, options.revisionAttribute, {
								type: Sequelize.BIGINT,
								defaultValue: 0,
							})
							.then(() => null)
							.catch(err => {
								log('something went really wrong..', err);
								return null;
							});
					}
					return null;
				});
			}

			this.addHook('beforeCreate', createBeforeHook('create'));
			this.addHook('beforeDestroy', createBeforeHook('destroy'));
			this.addHook('beforeUpdate', createBeforeHook('update'));
			this.addHook('afterCreate', createAfterHook('create'));
			this.addHook('afterDestroy', createAfterHook('destroy'));
			this.addHook('afterUpdate', createAfterHook('update'));
			this.addHook('afterBulkCreate', bulkCreateAfterHook('create'));
			this.addHook('beforeBulkCreate', bulkCreateBeforeHook('create'));

			// create association
			return this.hasMany(sequelize.models[options.revisionModel], {
				foreignKey: options.defaultAttributes.documentId,
				constraints: false,
				scope: {
					model: this.name,
				},
			});
		},
	});

	return {
		// Return defineModels()
		defineModels: function defineModels(db) {
			// Attributes for RevisionModel
			let attributes = {
				model: {
					type: Sequelize.TEXT,
					allowNull: false,
				},
				document: {
					type: Sequelize.JSONB,
					allowNull: false,
				},
				associateModel: {
					type: Sequelize.STRING,
				},
				associateModelIds: {
					type: Sequelize.default.STRING,
				},
				operation: Sequelize.STRING(7),
			};

			if (options.mysql) {
				attributes.document.type = Sequelize.TEXT('MEDIUMTEXT');
			}

			attributes[options.defaultAttributes.documentId] = {
				type: Sequelize.BIGINT,
				allowNull: false,
			};
			attributes[options.userModelAttribute] = {
				type: Sequelize.BIGINT,
				allowNull: false,
			};
			attributes[options.revisionAttribute] = {
				type: Sequelize.BIGINT,
				allowNull: false,
			};

			if (options.UUID) {
				attributes.id = {
					primaryKey: true,
					type: Sequelize.UUID,
					defaultValue: Sequelize.UUIDV4,
				};
				attributes[options.defaultAttributes.documentId].type =
					Sequelize.UUID;
			}

			if (options.debug) {
				log('attributes', attributes);
			}

			// Revision model
			const Revision = sequelize.define(
				options.revisionModel,
				attributes,
				{
					underscored: options.underscored,
					tableName: options.tableName,
				},
			);
			Revision.associate = function associate(models) {
				if (options.debug) {
					log('models', models);
				}

				Revision.belongsTo(
					sequelize.model(options.userModel),
					options.belongsToUserOptions,
				);
			};

			if (options.enableRevisionChangeModel) {
				// Attributes for RevisionChangeModel
				attributes = {
					path: {
						type: Sequelize.TEXT,
						allowNull: false,
					},
					document: {
						type: Sequelize.JSONB,
						allowNull: false,
					},
					diff: {
						type: Sequelize.JSONB,
						allowNull: false,
					},
				};

				if (options.mysql) {
					attributes.document.type = Sequelize.TEXT('MEDIUMTEXT');
					attributes.diff.type = Sequelize.TEXT('MEDIUMTEXT');
				}

				if (options.UUID) {
					attributes.id = {
						primaryKey: true,
						type: Sequelize.UUID,
						defaultValue: Sequelize.UUIDV4,
					};
				}
				// RevisionChange model
				const RevisionChange = sequelize.define(
					options.revisionChangeModel,
					attributes,
					{
						underscored: options.underscored,
					},
				);

				// Set associations
				Revision.hasMany(RevisionChange, {
					foreignKey: options.defaultAttributes.revisionId,
					constraints: false,
				});

				// https://github.com/nielsgl/sequelize-paper-trail/issues/10
				// RevisionChange.belongsTo(Revision, {
				// 	foreignKey: options.defaultAttributes.revisionId,
				// });
				RevisionChange.belongsTo(Revision);

				if (db) db[RevisionChange.name] = RevisionChange;
			}

			if (db) db[Revision.name] = Revision;

			/*
			 * We could extract this to a separate function so that having a
			 * user model doesn't require different loading
			 *
			 * or perhaps we could omit this because we are creating the
			 * association through the associate call above.
			 */
			if (options.userModel) {
				Revision.belongsTo(
					sequelize.model(options.userModel),
					options.belongsToUserOptions,
				);
			}

			return Revision;
		},
	};
};

/**
 * Throw exceptions when the user identifier from CLS is not set or if the
 * revisionAttribute was not loaded on the model.
 */
exports.enableFailHard = () => {
	failHard = true;
};

module.exports = exports;
