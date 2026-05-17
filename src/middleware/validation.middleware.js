// ============================================
// Request Validation Middleware
// ============================================
//
// WHY THIS EXISTS:
// Never trust user input. Always validate at the boundary
// (the HTTP layer) before data reaches business logic.
//
// We use express-validator which works as middleware:
// 1. Define rules as an array of validators
// 2. Run checkSchema() or validationResult()
// 3. If errors → reject with 400 before controller runs
//
// This prevents:
// - SQL/NoSQL injection via malformed prNumber
// - Server crashes from unexpected types
// - Logic errors from missing required fields
// ============================================
const { param, query, validationResult } = require('express-validator');

/**
 * Middleware: run validation rules and return 400 if any fail
 * Usage: router.get('/:id', [validatePRNumber], handleValidation, controller)
 */
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: errors.array().map((e) => ({
        field: e.path,
        message: e.msg,
        value: e.value,
      })),
    });
  }
  next();
};

/**
 * Validate :prNumber route param
 * Must be a positive integer (1–999999)
 */
const validatePRNumber = [
  param('prNumber')
    .trim()
    .notEmpty().withMessage('PR number is required')
    .isInt({ min: 1, max: 999999 }).withMessage('PR number must be a positive integer (1–999999)')
    .toInt(), // Coerce string "42" → number 42
  handleValidation,
];

/**
 * Validate cleanup query param
 * days must be 1–365 if provided
 */
const validateCleanupQuery = [
  query('days')
    .optional()
    .isInt({ min: 1, max: 365 }).withMessage('days must be between 1 and 365')
    .toInt(),
  handleValidation,
];

module.exports = { validatePRNumber, validateCleanupQuery, handleValidation };
