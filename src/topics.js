const { queryOverrides, subjectGroups } = require("../shared/topics.json");

const allTopics = subjectGroups.flatMap((group) => group.topics);

module.exports = { allTopics, queryOverrides, subjectGroups };
