import { sqliteTable,text,integer,primaryKey,index } from 'drizzle-orm/sqlite-core';
export const vaults=sqliteTable('vaults',{owner:text('owner').primaryKey(),version:integer('version').notNull().default(0),state:text('state').notNull(),lastCommand:text('last_command')});
export const commands=sqliteTable('commands',{owner:text('owner').notNull(),key:text('key').notNull(),fingerprint:text('fingerprint').notNull(),error:text('error')},t=>[primaryKey({columns:[t.owner,t.key]})]);
export const activity=sqliteTable('activity',{owner:text('owner').notNull(),id:text('id').notNull(),time:integer('time').notNull(),event:text('event').notNull()},t=>[primaryKey({columns:[t.owner,t.id]}),index('idx_activity_owner_time').on(t.owner,t.time)]);

