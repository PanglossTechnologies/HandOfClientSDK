<?php

declare(strict_types=1);

namespace HandOfClient\Host;

use Psr\Log\AbstractLogger;
use Psr\Log\LogLevel;

/**
 * The default logger: warnings and above go to PHP's error_log(), with the exception and every inner exception
 * (the previous chain). Pass any PSR-3 logger to HostModule to also get info per call and to route the output.
 */
final class ErrorLogLogger extends AbstractLogger
{
    private const LEVELS = [LogLevel::WARNING, LogLevel::ERROR, LogLevel::CRITICAL, LogLevel::ALERT, LogLevel::EMERGENCY];

    public function log($level, \Stringable|string $message, array $context = []): void
    {
        if (!in_array($level, self::LEVELS, true)) {
            return;
        }
        $line = "handofclient.$level: " . self::interpolate((string) $message, $context);
        if (($context['exception'] ?? null) instanceof \Throwable) {
            $line .= "\n" . (string) $context['exception']; // __toString includes the previous chain
        }
        error_log($line);
    }

    /** @param array<string,mixed> $context */
    private static function interpolate(string $message, array $context): string
    {
        $replace = [];
        foreach ($context as $key => $value) {
            if (is_scalar($value) || $value === null) {
                $replace['{' . $key . '}'] = (string) $value;
            }
        }

        return strtr($message, $replace);
    }
}
