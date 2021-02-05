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
 * 
 * @param {import("sequelize").SequelizeStaticAndInstance} sequelize The sequelize instance
 * @param {Object[]} migrationFiles Migration files
 * @param {string} migrationFiles.name The name of the migration
 * @param {string} migrationFiles.fullPath The path to the migration 
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
        },
        logging: (message, ...args) => console.log(message, ...args),
        migrations: Umzug.migrationsList(migrationFiles.map(file => {
            const migration = require(file.fullPath);
            if (!migration) throw Error(`Unable to load migration from "${file.fullPath}"`);
            if (migrationOptions.step > 0) {
                console.log(`Set position to ${migrationOptions.step}`);
                migration.pos = migrationOptions.step;
            }
            migration.useTransaction = migrationOptions.useTransaction;
            migration.name = file.name;
            return migration;
        }), [sequelize.getQueryInterface(), Sequelize])
    });
    return migrator;
}

function ShowMigration(migration) {
    console.log(`\tPending Migration: ${migration.file}`);
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

    let migrationFiles = fs.readdirSync(migrationsDir)
    // filter JS files
    .filter((file) => {
        return (file.indexOf('.') !== 0) && (file.slice(-3) === '.js');
    })
    // sort by revision
    .sort( (a, b) => {
        let revA = parseInt( path.basename(a).split('-',2)[0]),
            revB = parseInt( path.basename(b).split('-',2)[0]);
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
        console.log(`\t${file}`);
    });

    const migrationFileList = migrationFiles.map((file) => {
        return {
            get name() {
                return file;
            },
            get fullPath() {
                path.join(migrationsDir, file);
            }
        }
    });

    const migrator = getMigrator(sequelize, migrationFileList, {
        useTransaction: !noTransaction,
        step: fromPos
    });

    if (options.list) {
        const executed = await migrator.executed();
        executed.forEach(ShowMigration);
        const pending = await migrator.pending();
        pending.forEach(ShowMigration);
        process.exit(0);
    }

    try {
        const migrations = [];
        const methodOptions = { 
            to: options.to,
            from: options.from,
        };
        if (!rollback) {
            const executed = await migrator.up(methodOptions);
            migrations.push(...executed);
        } else {
            const executed = await migrator.down(methodOptions);
            migrations.push(...executed);
        }
        console.log(`Executed ${migrations.length} migrations`);
        migrations.forEach(ShowMigration);
    } catch (migError) {
        console.error(migError);
    }
}

(async function() {
    try {
        await Main();
    } catch (error) {
        console.error(error);
    }
})();