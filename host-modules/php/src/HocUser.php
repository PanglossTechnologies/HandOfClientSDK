<?php

declare(strict_types=1);

namespace HandOfClient\Host;

/** The site's user, as the host module sees it. `raw` is whatever getCurrentUser returned. */
final class HocUser
{
    public function __construct(
        public readonly string $id,
        public readonly ?string $name = null,
        public readonly ?string $email = null,
        public readonly mixed $raw = null,
    ) {
    }

    /**
     * Accept an array or an object with `id` (and optionally `name` / `email`), as a public property, a magic
     * property (Eloquent) or a getId()/getName()/getEmail() method. null / no id means signed out.
     */
    public static function from(mixed $user): ?self
    {
        if ($user === null || $user === false) {
            return null;
        }
        $id = self::field($user, 'id');
        if ($id === null || !is_scalar($id) || (string) $id === '') {
            return null;
        }
        $name = self::field($user, 'name');
        $email = self::field($user, 'email');

        return new self(
            (string) $id,
            is_scalar($name) && (string) $name !== '' ? (string) $name : null,
            is_scalar($email) && (string) $email !== '' ? (string) $email : null,
            $user,
        );
    }

    /** Read a field from an array or object (public/magic property, then getter). Null when absent. */
    public static function field(mixed $obj, string $name): mixed
    {
        if (is_array($obj)) {
            return $obj[$name] ?? null;
        }
        if (is_object($obj)) {
            if (isset($obj->{$name})) {
                return $obj->{$name};
            }
            $getter = 'get' . ucfirst($name);
            if (method_exists($obj, $getter)) {
                return $obj->{$getter}();
            }
        }

        return null;
    }
}
