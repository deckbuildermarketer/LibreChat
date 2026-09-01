/**
 * Open Responses API routes for LibreChat agents.
 *
 * Implements the Open Responses specification for a forward-looking,
 * agentic API that uses items as the fundamental unit and semantic
 * streaming events.
 *
 * Usage:
 *   POST /v1/responses - Create a response
 *   GET /v1/models - List available agents
 *
 * Request format:
 *   {
 *     "model": "agent_id_here",
 *     "input": "Hello!" or [{ type: "message", role: "user", content: "Hello!" }],
 *     "stream": true,
 *     "previous_response_id": "optional_conversation_id"
 *   }
 *
 * @see https://openresponses.org/specification
 */
const express = require('express');
const {
  createResponse,
  getResponse,
  listModels,
} = require('~/server/controllers/agents/responses');
const {
  createPreparedPreSalesWorkspace,
} = require('~/server/controllers/agents/preSalesWorkspace');
const { configMiddleware } = require('~/server/middleware');
const {
  checkAgentPermission,
  preAuthTenantMiddleware,
  requireRemoteAgentAuth,
  checkRemoteAgentsFeature,
} = require('./middleware');

const router = express.Router();

router.use(preAuthTenantMiddleware);
router.use(requireRemoteAgentAuth);
router.use(configMiddleware);
router.use(checkRemoteAgentsFeature);

/**
 * @route POST /v1/responses
 * @desc Create a model response following Open Responses specification
 * @access Private (API key auth required)
 */
router.post('/', checkAgentPermission, createResponse);

/**
 * @route GET /v1/responses/models
 * @desc List available agents as models
 * @access Private (API key auth required)
 */
router.get('/models', listModels);

/**
 * Internal DBM pre-sales handoff endpoint.
 * Requires the normal Remote Agents API key plus X-Pre-Sales-Service-Key.
 * It creates an idempotent, user-owned LibreChat conversation with the
 * pre-call document mirrored into the conversation context.
 */
router.post('/pre-sales/conversations', createPreparedPreSalesWorkspace);

/**
 * @route GET /v1/responses/:id
 * @desc Retrieve a stored response by ID
 * @access Private (API key auth required)
 */
router.get('/:id', getResponse);

module.exports = router;
