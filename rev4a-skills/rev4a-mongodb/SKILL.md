---
name: rev4a-mongodb
description: Query the MongoDB database Rev4a connected to this agent, read-only, with mongosh.
metadata: {"openclaw":{"emoji":"🍃","requires":{"bins":["mongosh"],"env":["REV4A_MONGODB_URI"]},"primaryEnv":"REV4A_MONGODB_URI"}}
---

# MongoDB (read-only, mongosh)

Rev4a connected a MongoDB database to this agent. Query it with `mongosh`.

## The connection string

- The connection string is only in `$REV4A_MONGODB_URI`. It exists only inside commands you run with your exec tool.
- It contains a password. Never print, echo, log, store or paste it, and never put its value in a message.
- Always pass it quoted: `"$REV4A_MONGODB_URI"`.

## Read-only

Access is read-only. A write fails with "not authorized". Do not retry it and do not look for a way around it: tell the user.

## Querying

- Always use a projection and a limit. Never dump a whole collection.
- Print compact output with `EJSON.stringify`:

```
mongosh "$REV4A_MONGODB_URI" --quiet --eval 'EJSON.stringify(db.getCollectionNames())'
mongosh "$REV4A_MONGODB_URI" --quiet --eval 'EJSON.stringify(db.users.find({active: true}, {name: 1, email: 1}).limit(20).toArray())'
mongosh "$REV4A_MONGODB_URI" --quiet --eval 'EJSON.stringify(db.orders.countDocuments({status: "open"}))'
mongosh "$REV4A_MONGODB_URI" --quiet --eval 'EJSON.stringify(db.orders.aggregate([{$match: {status: "open"}}, {$group: {_id: "$customer", n: {$sum: 1}}}, {$limit: 20}]).toArray())'
mongosh "$REV4A_MONGODB_URI" --quiet --eval 'EJSON.stringify(db.getSiblingDB("other").getCollectionNames())'
```

Use single quotes around the `--eval` script, so the shell leaves `$match` and `$group` alone.

## Errors

- "Authentication failed": the credential saved in Rev4a is wrong. Tell the user.
- `MongoNetworkError`, `ENOTFOUND` or `ECONNREFUSED`: the database is not reachable from this agent. Tell the user.
- "not authorized": expected for writes, and for databases the user's role does not cover.
- `mongosh: not found`: ask the user to switch MongoDB off and on again in Rev4a.
