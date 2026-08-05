import { config } from '../config.js';

export function isStaff(member) {
  if (!member) return false;
  if (member.permissions?.has?.('Administrator')) return true;
  return member.roles.cache.has(config.staffRoleId);
}

export function hasBannedRole(member) {
  if (!member || !config.bannedRoleId) return false;
  return member.roles.cache.has(config.bannedRoleId);
}

export function formatAud(cents) {
  return `$${(cents / 100).toFixed(2)} AUD`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function addHoursIso(hours, from = new Date()) {
  return new Date(from.getTime() + hours * 60 * 60 * 1000).toISOString();
}

export function addDaysIso(days, from = new Date()) {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
