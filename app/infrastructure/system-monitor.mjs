/*
  Global System Load Monitor
  
  Continuously monitors system resources and provides recommendations
  for dynamic concurrency adjustment across the application.
*/

import os from 'os';
import { EventEmitter } from 'events';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

// Configuration
const config = {
  monitoringInterval: 2000,
  historySize: 5,
  thresholds: {
    cpu: { critical: 0.85, high: 0.7, normal: 0.4 },
    memory: { critical: 0.9, high: 0.8, normal: 0.6 }
  }
};

// State
let interval = null;
let history = { cpu: [], memory: [] };
const emitter = new EventEmitter();

// Private functions
function collectMetrics() {
  const cpuLoad = os.loadavg()[0] / os.cpus().length;
  const memUsage = process.memoryUsage();
  const memLoad = memUsage.rss / os.totalmem();
  
  logger.trace(`System metrics - CPU: ${(cpuLoad * 100).toFixed(1)}%, Memory: ${(memLoad * 100).toFixed(1)}%`);
  
  return { cpuLoad, memLoad, timestamp: Date.now() };
}

function updateHistory(metrics) {
  history.cpu.push(metrics.cpuLoad);
  history.memory.push(metrics.memLoad);
  
  if (history.cpu.length > config.historySize) {
    history.cpu.shift();
    history.memory.shift();
  }
}

function analyzeLoad() {
  if (history.cpu.length === 0) {
    return { action: 'MAINTAIN', factor: 1.0 };
  }

  const avgCpu = history.cpu.reduce((a, b) => a + b) / history.cpu.length;
  const avgMem = history.memory.reduce((a, b) => a + b) / history.memory.length;
  
  let recommendation;
  if (avgCpu > config.thresholds.cpu.critical || avgMem > config.thresholds.memory.critical) {
    recommendation = { action: 'REDUCE_AGGRESSIVE', factor: 0.5 };
  } else if (avgCpu > config.thresholds.cpu.high || avgMem > config.thresholds.memory.high) {
    recommendation = { action: 'REDUCE', factor: 0.8 };
  } else if (avgCpu < config.thresholds.cpu.normal && avgMem < config.thresholds.memory.normal) {
    recommendation = { action: 'INCREASE', factor: 1.2 };
  } else {
    recommendation = { action: 'MAINTAIN', factor: 1.0 };
  }
  
  logger.trace(`Load analysis - Avg CPU: ${(avgCpu * 100).toFixed(1)}%, Avg Memory: ${(avgMem * 100).toFixed(1)}% ??? ${recommendation.action}`);
  
  return recommendation;
}

// Public API
export function start() {
  if (interval) return; // Already running
  
  interval = setInterval(() => {
    const metrics = collectMetrics();
    updateHistory(metrics);
    const recommendation = analyzeLoad();
    logger.trace(`Emitting load-update event with recommendation: ${recommendation.action}`);
    emitter.emit('load-update', { metrics, recommendation });
  }, config.monitoringInterval);
  
  logger.info('System load monitoring started');
}

export function stop() {
  if (interval) {
    clearInterval(interval);
    interval = null;
    logger.info('System load monitoring stopped');
  }
}

export function on(event, listener) {
  emitter.on(event, listener);
}

export function removeAllListeners(event) {
  emitter.removeAllListeners(event);
}

export function getMetrics() {
  if (history.cpu.length === 0) return null;
  
  const avgCpu = history.cpu.reduce((a, b) => a + b) / history.cpu.length;
  const avgMem = history.memory.reduce((a, b) => a + b) / history.memory.length;
  
  return { avgCpu, avgMem, historySize: history.cpu.length };
}

export function getCurrentRecommendation() {
  if (history.cpu.length === 0) {
    return { action: 'MAINTAIN', factor: 1.0 };
  }
  return analyzeLoad();
}