#!/usr/bin/env node

const path              = require("path");
const commandLineArgs   = require('command-line-args');
const fs                = require("fs");
const Async             = require("async");
const Umzug             = require('umzug');
const Sequelize         = require('sequelize');

const pathConfig = require('../lib/pathconfig');

const optionDefinitions = [
    { name: 'to', type: String, description: 'The migration target' },
    { name: 'from', type: String, description: 'Set the migration to start from' },
    { name: 'toRev', type: Number, description: 'The migration target' },
    { name: 'fromRev', type: Number, description: 'Set the migration to start from' },
    { name: 'rollback', alias: 'b', type: Boolean, description: 'Rollback to specified revision', defaultValue: false },
    { name: 'pos', alias: 'p', type: Number, description: 'Run first migration at pos (default: 0)', defaultValue: 0 },
    { name: 'no-transaction', type: Boolean, description: 'Run each change separately instead of all in a transaction (allows it to fail and continue)', defaultValue: false },
    // { name: 'one', type: Boolean, description: 'Do not run next migrations', defaultValue: false },
    { name: 'list', alias: 'l', type: Boolean, description: 'Show migration file list (without execution)', defaultValue: false },
    { name: 'migrations-path', type: String, description: 'The path to the migrations folder' },
    { name: 'models-path', type: String, description: 'The path to the models folder' },
    { name: 'help', type: Boolean, description: 'Show this message' }
];

/** 
 * @typedef AutoMigrationFile
 * @property {number} fulLPath The full path to the file
 * @property {string} name The name of the file
 * @property {AutoMigration} migration The loaded migration
 */

/** 
 * @typedef AutoMigration
 * @property {Object} info Migration information
 * @property {number} info.revision The revision number
 * @property {string} info.name The name of the migration
 * @property {string} info.created The date the migration was created, as a string
 * @property {string} info.comment Comments about the migration
 * @property {number} pos The step in the migration to start running at
 * @property {boolean} useTransaction Wrap entire migration in a transaction
 * @property {(queryInterface: import('sequelize').QueryInterface, Sequelize: import('sequelize').Sequelize, _commands: any) => Promise<void>} migrationFiles.migration.execute `sequelize-auto-migrations` execute method
 * @property {(queryInterface: import('sequelize').QueryInterface, Sequelize: import('sequelize').Sequelize) => Promise<void>} migrationFiles.migration.up Migration up method
 * @property {(queryInterface: import('sequelize').QueryInterface, Sequelize: import('sequelize').Sequelize) => Promise<void>} migrationFiles.migration.down Migration down method
 */

/**
 * 
 * @param {import("sequelize").SequelizeStaticAndInstance} sequelize The sequelize instance
 * @param {AutoMigrationFile[]} migrationFiles Migration files
 * @param {Object} migrationOptions Options to pass to each migration
 * @param {boolean} migrationOptions.useTransaction Wrap entire migration in a transaction
 * @param {number} migrationOptions.step The step to start the migration at
 */
function getMigrator(sequelize, migrationFiles, migrationOptions) {
    const migrator = new Umzug({
        storage: "sequelize",
        storageOptions: {
            tableName: 'SequelizeMeta',
            timestamps: false,
            sequelize,
        },
        logging: (message, ...args) => console.log(message, ...args),
        migrations: Umzug.migrationsList(migrationFiles.map(file => {
            const { migration } = file;
            if (!migration) throw Error(`Unable to load migration from "${file.fullPath}"`);
            if (migrationOptions.step > 0) {
                console.log(`Set position to ${migrationOptions.step}`);
                migration.pos = migrationOptions.step;
            }
            migration.useTransaction = migrationOptions.useTransaction;
            migration.name = file.name;
            migration.up = migration.up.bind(migration);
            migration.down = migration.down.bind(migration);
            return migration;
        }), [sequelize.getQueryInterface(), Sequelize])
    });
    return migrator;
}

function ShowMigration(migration) {
    console.log(`\tMigration: ${migration.file}`);
}

/**
 * Main migration method
 */
async function Main() {
    const options = commandLineArgs(optionDefinitions);

    // Windows support
    if(!process.env.PWD){
        process.env.PWD = process.cwd()
    }

    let {
        migrationsDir, 
        modelsDir
    } = pathConfig(options);

    if (!fs.existsSync(modelsDir)) {
        console.log("Can't find models directory. Use `sequelize init` to create it")
        return
    }

    if (!fs.existsSync(migrationsDir)) {
        console.log("Can't find migrations directory. Use `sequelize init` to create it")
        return
    }

    if (options.help)
    {
        console.log("Simple sequelize migration execution tool\n\nUsage:");
        optionDefinitions.forEach((option) => {
            let alias = (option.alias) ? ` (-${option.alias})` : '\t';
            console.log(`\t --${option.name}${alias} \t${option.description}`);
        });
        process.exit(0);
    }

    const sequelize = require(modelsDir).sequelize;

    // execute all migration from
    /**
     * The step in the migration to run
     */
    let fromPos = parseInt(options.pos);
    // let stop = options.one;
    /**
     * Are we performing a rollback
     */
    let rollback = options.rollback;
    /**
     * Run migration without a transaction
     */
    let noTransaction = options['no-transaction'];

    /**
     * @type {AutoMigrationFile[]}
     */
    const migrationFiles = fs.readdirSync(migrationsDir)
    // filter JS files
    .filter((file) => {
        return (file.indexOf('.') !== 0) && (file.slice(-3) === '.js');
    })
    // Load migrations
    .map((file) => {
        /**
         * @type {AutoMigrationFile}
         */
        return {
            get name() {
                return file;
            },
            get fullPath() {
                return path.join(migrationsDir, file);
            },
            /**
             * @type {AutoMigration}
             */
            migration: require(path.join(migrationsDir, file))
        }
    })
    // sort by revision
    .sort( (a, b) => {
        let revA = parseInt( path.basename(a.name).split('-',2)[0]),
            revB = parseInt( path.basename(b.name).split('-',2)[0]);
        if (rollback) {
            if (revA < revB) return 1;
            if (revA > revB) return -1;
        } else {
            if (revA < revB) return -1;
            if (revA > revB) return 1;
        }
        return 0;
    });
    
    console.log("Migrations found:");  
    migrationFiles.forEach((file) => {
        console.log(`\t${file.name}`);
    });

    const migrator = getMigrator(sequelize, migrationFiles, {
        useTransaction: !noTransaction,
        step: fromPos
    });

    if (options.list) {
        const executed = await migrator.executed();
        console.log(`Executed:`);
        executed.forEach(ShowMigration);
        console.log(``);

        const pending = await migrator.pending();
        console.log(`Pending:`);
        pending.forEach(ShowMigration);
        console.log(``);
        process.exit(0);
    }

    try {
        const migrations = [];
        let toMigration = null, fromMigration = null;
        const {
            to = undefined,
            from = undefined,
            toRev = undefined,
            fromRev = undefined
        } = options;
        toMigration = to;
        fromMigration = from;
        // If we have specified a revision to go from and to go to
        if (!toMigration && toRev && !fromMigration && fromRev)
        {
            if (toRev < fromRev && rollback || toRev > fromRev && !rollback) {
                const _toMigration = migrationFiles.find(e => e.migration ? e.migration.info.revision === toRev : false);
                const _fromMigration = migrationFiles.find(e => e.migration ? e.migration.info.revision === fromRev : false);
                if (_toMigration && _fromMigration) {
                    toMigration = _toMigration.name;
                    fromMigration = _fromMigration.name;
                }
            }
        } else if (!toMigration && toRev && !fromMigration && !fromRev) {
            // If we have specified a revition to go to only 
            const _toMigration = migrationFiles.find(e => e.migration ? e.migration.info.revision === toRev : false);
            if (_toMigration) {
                toMigration = _toMigration.name;
            }
        } else if (!toMigration && !toRev && !fromMigration && fromRev) { 
            // If we have specified a revition to go from only
            const _fromMigration = migrationFiles.find(e => e.migration ? e.migration.info.revision === fromRev : false);
            if (_fromMigration) {
                fromMigration = _fromMigration.name;
            }
        }
        
        const methodOptions = { 
            to: toMigration,
            from: fromMigration,
        };
        console.log(`Migration Options`, methodOptions)
        if (!rollback) {
            console.log(`Migrating up`);
            const executed = await migrator.up(methodOptions);
            migrations.push(...executed);
        } else {
            console.log(`Migrating down`);
            const executed = await migrator.down(methodOptions);
            migrations.push(...executed);
        }
        console.log(`Executed ${migrations.length} migrations:`);
        migrations.forEach(ShowMigration);
        process.exit(0);
    } catch (migError) {
        console.error(migError);
        process.exit(1);
    }
}

(async function() {
    try {
        await Main();
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();