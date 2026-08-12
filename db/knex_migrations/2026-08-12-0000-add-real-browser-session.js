exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.boolean("browser_persist_session").notNullable().defaultTo(false);
        table.text("browser_ready_selector").nullable();
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.dropColumn("browser_persist_session");
        table.dropColumn("browser_ready_selector");
    });
};
