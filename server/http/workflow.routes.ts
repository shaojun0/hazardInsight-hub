/** Workflow 控制面只读/校验 API；发布和执行待真实 Node 适配后开放。 */
import express, { Router } from 'express';
import type { WorkflowControlPlane } from '../workflow/bootstrap.js';
import { inferWorkflowFormat, loadWorkflowSource, parseWorkflowObject, WorkflowLoadError } from '../workflow/loader.js';
import { validateWorkflow } from '../workflow/validator.js';
import { sendError, sendJson } from './helpers.js';

export function createWorkflowRoutes(control: WorkflowControlPlane): Router {
  const router = Router();

  router.get('/node-catalog', (_req, res) => {
    sendJson(res, { data: control.nodes.catalog() });
  });

  router.get('/workflows', (_req, res) => {
    sendJson(res, {
      data: control.workflows.list().map((revision) => ({
        id: revision.definition.metadata.id,
        name: revision.definition.metadata.name,
        version: revision.definition.metadata.version,
        status: revision.status,
        hash: revision.hash,
        valid: revision.validation.valid,
        warnings: revision.validation.warnings.length,
      })),
    });
  });

  router.get('/workflows/:id/versions/:version', (req, res) => {
    const revision = control.workflows.get(req.params.id, req.params.version);
    if (!revision) {
      sendError(res, 404, 'Workflow 版本不存在。', 'WORKFLOW_NOT_FOUND');
      return;
    }
    sendJson(res, { data: revision });
  });

  router.post(
    '/workflows/validate',
    express.text({ type: ['application/yaml', 'application/x-yaml', 'text/yaml', 'text/plain'], limit: '1mb' }),
    (req, res) => {
      try {
        const definition = typeof req.body === 'string'
          ? loadWorkflowSource(req.body, inferWorkflowFormat(req.headers['content-type'], req.body))
          : parseWorkflowObject(req.body);
        sendJson(res, { data: validateWorkflow(definition, control.nodes) });
      } catch (error) {
        if (error instanceof WorkflowLoadError) {
          res.status(400).json({ error: 'Workflow 配置无效。', code: 'WORKFLOW_SCHEMA_INVALID', issues: error.issues });
          return;
        }
        sendError(res, 500, 'Workflow 校验异常。', 'WORKFLOW_VALIDATION_FAILED');
      }
    }
  );

  return router;
}

