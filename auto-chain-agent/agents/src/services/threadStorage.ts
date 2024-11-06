import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import logger from '../logger';
import { HumanMessage, AIMessage, BaseMessage, SystemMessage } from '@langchain/core/messages';
import path from 'path';
import { ChatOpenAI } from "@langchain/openai";

export interface ThreadState {
    messages: BaseMessage[];
    toolCalls: Array<{
        id: string;
        type: string;
        function: {
            name: string;
            arguments: string;
        };
        result?: string;
    }>;
}

const initializeDb = async (dbPath: string) => {
    logger.info('Initializing SQLite database at:', dbPath);

    const db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    // Only create table if it doesn't exist
    await db.exec(`
        CREATE TABLE IF NOT EXISTS threads (
            thread_id TEXT PRIMARY KEY,
            messages TEXT NOT NULL,
            tool_calls TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    return db;
};

const createMessage = (type: 'human' | 'ai', content: string) =>
    type === 'human' ? new HumanMessage({ content }) : new AIMessage({ content });

const serializeMessage = (msg: BaseMessage) => ({
    _type: msg._getType(),
    content: msg.content,
    additional_kwargs: msg.additional_kwargs
});

const deserializeMessage = (msg: any) => {
    if (!msg) return createMessage('ai', 'Invalid message');
    return createMessage(
        msg._type === 'human' ? 'human' : 'ai',
        msg.content
    );
};

export const createThreadStorage = () => {
    const dbPath = path.join(process.cwd(), 'thread-storage.sqlite');
    const dbPromise = initializeDb(dbPath);

    return {
        async saveThread(threadId: string, state: ThreadState) {
            try {
                const db = await dbPromise;
                const threadData = {
                    threadId,
                    messageCount: state.messages.length,
                    toolCallCount: state.toolCalls.length
                };
                logger.info(`Preparing to save thread data: ${JSON.stringify(threadData)}`);

                const serializedMessages = JSON.stringify(state.messages.map(serializeMessage));
                const serializedToolCalls = JSON.stringify(state.toolCalls);
                
                const serializedInfo = {
                    messagesLength: serializedMessages.length,
                    toolCallsLength: serializedToolCalls.length
                };
                logger.info(`Serialized data: ${JSON.stringify(serializedInfo)}`);

                const result = await db.run(
                    `INSERT OR REPLACE INTO threads (thread_id, messages, tool_calls, updated_at)
                     VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
                    [
                        threadId,
                        serializedMessages,
                        serializedToolCalls
                    ]
                );

                logger.info(`Database operation result: ${JSON.stringify(result)}`);

                // Verify the save immediately
                const verification = await db.get(
                    'SELECT thread_id, length(messages) as msg_len FROM threads WHERE thread_id = ?',
                    threadId
                );
                
                logger.info(`Verification result: ${JSON.stringify(verification)}`);

                if (!verification) {
                    throw new Error('Failed to verify saved data');
                }
            } catch (error) {
                logger.error('Error in saveThread:', error);
                logger.error('Full error details:', {
                    name: (error as Error).name,
                    message: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                });
                throw error;
            }
        },

        async loadThread(threadId: string): Promise<ThreadState | null> {
            const db = await dbPromise;
            const row = await db.get(
                'SELECT messages, tool_calls FROM threads WHERE thread_id = ?',
                threadId
            );

            if (!row) {
                logger.warn(`Thread not found: ${threadId}`);
                return null;
            }

            return {
                messages: JSON.parse(row.messages).map(deserializeMessage),
                toolCalls: JSON.parse(row.tool_calls || '[]')
            };
        },

        async getAllThreads() {
            const db = await dbPromise;
            return db.all(
                'SELECT thread_id, created_at, updated_at FROM threads ORDER BY updated_at DESC'
            );
        },

        async deleteThread(threadId: string) {
            const db = await dbPromise;
            await db.run('DELETE FROM threads WHERE thread_id = ?', threadId);
            logger.info(`Thread deleted: ${threadId}`);
        },

        async cleanup(olderThanDays = 30) {
            const db = await dbPromise;
            const result = await db.run(
                'DELETE FROM threads WHERE updated_at < datetime("now", ?)',
                [`-${olderThanDays} days`]
            );
            const deletedCount = result.changes || 0;
            logger.info(`Cleaned up ${deletedCount} old threads`);
            return deletedCount;
        }
    };
};

export const loadThreadSummary = async () => {
    const threadStorage = createThreadStorage();
    const threads = await threadStorage.getAllThreads();
    
    // Process threads in batches to avoid memory issues
    const BATCH_SIZE = 5;
    const summaries = [];
    
    for (let i = 0; i < threads.length; i += BATCH_SIZE) {
        const batch = threads.slice(i, i + BATCH_SIZE);
        const batchMessages = await Promise.all(batch.map(async (thread) => {
            const state = await threadStorage.loadThread(thread.thread_id);
            if (!state?.messages.length) return null;
            
            // Get last few messages for context
            const lastMessages = state.messages.slice(-3);
            return lastMessages.map(msg => ({
                role: msg._getType(),
                content: msg.content
            }));
        }));

        // Filter out null results and format for summarization
        const validMessages = batchMessages.filter((msg): msg is NonNullable<typeof msg> => msg !== null);
        if (validMessages.length === 0) continue;

        // Format messages for better context
        const formattedMessages = validMessages.map(thread => 
            thread.map(msg => `${msg.role}: ${msg.content}`).join('\n')
        ).join('\n---\n');

        // Use the existing model to summarize
        const model = new ChatOpenAI({
            modelName: "gpt-4-turbo-preview",
            temperature: 0.3
        });

        const summary = await model.invoke([
            new SystemMessage({
                content: `You are a precise thread summarizer. For each conversation thread:
                1. Extract key information:
                   - User names and identifiers
                   - Blockchain addresses mentioned
                   - Transaction details and amounts
                   - Important decisions or actions taken
                
                2. Format the summary as:
                   - Context: [Brief background]
                   - Key Points: [Bullet points of main details]
                   - Outcome: [Final result or status]
                
                Keep each thread summary concise (2-3 sentences max) and focus on actionable/important information.
                Exclude general chitchat or non-essential details.`
            }),
            new HumanMessage({ content: formattedMessages })
        ]);

        summaries.push(summary.content);
    }

    logger.info(`Generated ${summaries.length} thread summaries`);
    return summaries;
};

export type ThreadStorage = ReturnType<typeof createThreadStorage>;
