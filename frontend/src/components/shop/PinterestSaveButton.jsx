/**
 * PinterestSaveButton
 * ───────────────────
 * Sends customers to Pinterest's official pin-create dialog with the
 * product image, URL, and a descriptive caption pre-filled. Uses the
 * public Pinterest endpoint — no API key, no approval required, works
 * the same as the "Pin it" bookmarklet but as a styled in-page button.
 *
 * Pinterest will scrape our Rich Pin meta tags on the destination URL,
 * so the resulting pin shows live price + availability + brand without
 * us doing anything extra.
 */
import React from 'react';
import PropTypes from 'prop-types';

const buildPinUrl = ({ url, media, description }) => {
  const params = new URLSearchParams({
    url: url || '',
    media: media || '',
    description: description || '',
  });
  return `https://www.pinterest.com/pin/create/button/?${params.toString()}`;
};

export default function PinterestSaveButton({
  url,
  media,
  description,
  size = 'md',
  label = 'Save',
  className = '',
}) {
  if (!url || !media) return null;
  const href = buildPinUrl({ url, media, description });
  const sizeClasses = size === 'sm'
    ? 'px-2.5 py-1 text-xs gap-1'
    : 'px-3 py-1.5 text-sm gap-1.5';
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-pin-do="buttonPin"
      data-pin-custom="true"
      data-testid="pinterest-save-btn"
      className={`inline-flex items-center rounded-full bg-[#E60023] hover:bg-[#AD081B] text-white font-semibold transition shadow-sm ${sizeClasses} ${className}`}
      title="Save this to Pinterest"
      aria-label="Save to Pinterest"
    >
      {/* Pinterest "P" mark — inline SVG to avoid any third-party JS */}
      <svg viewBox="0 0 24 24" width={size === 'sm' ? 12 : 14} height={size === 'sm' ? 12 : 14} fill="currentColor" aria-hidden="true">
        <path d="M12 0C5.4 0 0 5.4 0 12c0 5 3 9.3 7.4 11.1-.1-.9-.2-2.4 0-3.4.2-.9 1.5-5.7 1.5-5.7s-.4-.8-.4-1.9c0-1.7 1-3.1 2.3-3.1 1.1 0 1.6.8 1.6 1.8 0 1.1-.7 2.7-1 4.2-.3 1.2.6 2.2 1.8 2.2 2.2 0 3.8-2.3 3.8-5.6 0-2.9-2.1-5-5.1-5-3.5 0-5.5 2.6-5.5 5.3 0 1 .4 2.2.9 2.8.1.1.1.2.1.3-.1.4-.3 1.2-.4 1.4-.1.2-.2.3-.4.2-1.5-.7-2.4-2.8-2.4-4.6 0-3.7 2.7-7.1 7.8-7.1 4.1 0 7.3 2.9 7.3 6.8 0 4.1-2.6 7.4-6.2 7.4-1.2 0-2.3-.6-2.7-1.4l-.7 2.8c-.3 1-1 2.4-1.5 3.2 1.1.4 2.3.5 3.5.5 6.6 0 12-5.4 12-12S18.6 0 12 0z"/>
      </svg>
      <span>{label}</span>
    </a>
  );
}

PinterestSaveButton.propTypes = {
  url: PropTypes.string.isRequired,
  media: PropTypes.string.isRequired,
  description: PropTypes.string,
  size: PropTypes.oneOf(['sm', 'md']),
  label: PropTypes.string,
  className: PropTypes.string,
};
