const express = require('express');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testEndpoint() {
    BigInt.prototype.toJSON = function () { return this.toString() };
    const id = 'f43f7a88-45c8-4665-95ff-8eb0df8763f1'; // Новый опрос

    const totalUsers = await prisma.user.count({
        where: { answers: { some: { question: { surveyId: id } } } }
    });

    const completedUsers = await prisma.user.count({
        where: { status: 'COMPLETED', answers: { some: { question: { surveyId: id } } } }
    });

    console.log(`Новый опрос Total: ${totalUsers}, Completed: ${completedUsers}`);

    const answers = await prisma.answer.findMany({
        where: { question: { surveyId: id } }
    });

    console.log(`Total answers for 'Новый опрос': ${answers.length}`);
}

testEndpoint().then(() => process.exit(0));
