import React from 'react';

const BotScoreBadge = ({
  grade,
  score,
  size = 'md',
  showScore = false,
  className = ''
}) => {
  const gradeColors = {
    A: 'bg-emerald-500 text-white',
    B: 'bg-green-500 text-white',
    C: 'bg-sky-500 text-white',
    D: 'bg-yellow-500 text-navy-900',
    F: 'bg-red-500 text-white'
  };

  const sizeClasses = {
    sm: 'text-xs px-1.5 py-0.5 min-w-[20px]',
    md: 'text-sm px-2 py-1 min-w-[28px]',
    lg: 'text-base px-3 py-1.5 min-w-[36px]'
  };

  const gradeDescriptions = {
    A: 'Excellent - Very low bot activity',
    B: 'Good - Minimal bot activity',
    C: 'Fair - Some bot activity detected',
    D: 'Poor - Significant bot activity',
    F: 'Critical - High bot activity'
  };

  // Handle null/undefined grade with placeholder
  if (!grade) {
    return (
      <span
        className={`rounded-md font-bold text-center bg-gray-300 text-gray-600 text-sm px-2 py-1 min-w-[28px] inline-block ${className}`}
        title="No bot score data"
      >
        —
      </span>
    );
  }

  // Build tooltip text
  let tooltipText = gradeDescriptions[grade] || '';
  if (showScore && score !== undefined) {
    tooltipText += ` (${Math.round(score)}/100)`;
  }

  const colorClass = gradeColors[grade] || gradeColors.C;
  const sizeClass = sizeClasses[size] || sizeClasses.md;

  return (
    <span
      className={`rounded-md font-bold text-center inline-block ${colorClass} ${sizeClass} ${className}`}
      title={tooltipText}
    >
      {grade}
    </span>
  );
};

export default BotScoreBadge;
