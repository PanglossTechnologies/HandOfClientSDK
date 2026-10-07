<?php
/**
 * Standalone tests for HOC_Hooks' two pure pieces: the declarative filter transform and the
 * hook-argument reducer.
 *
 * Runs without WordPress and without PHPUnit, same as test-jwt.php:
 *
 *   php host-adapters/wordpress/handofclient/tests/test-hooks.php
 *
 * These two functions are worth testing in isolation because both are security properties, not just
 * behaviour. apply_transform() runs inside a filter WordPress is BLOCKED on, so every branch has to
 * be total - a throw or a type coercion there corrupts a live page. reduce_arg() is the only thing
 * standing between a `save_post` declaration and a whole WP_Post being couriered off-site.
 *
 * @package HandOfClient
 */

define( 'ABSPATH', __DIR__ );

// HOC_Hooks references HOC_Mounts/HOC_Options/HOC_Platform_Client at registration and dispatch time,
// but neither function under test touches them, so the class loads standalone.
require_once dirname( __DIR__ ) . '/includes/class-hoc-hooks.php';

$tests  = 0;
$failed = 0;

/**
 * @param string $name      Test name.
 * @param bool   $condition Assertion.
 * @return void
 */
function ok( $name, $condition ) {
	global $tests, $failed;
	++$tests;
	if ( $condition ) {
		echo "  ok   $name\n";
	} else {
		++$failed;
		echo "  FAIL $name\n";
	}
}

/**
 * Calls a private method on HOC_Hooks.
 *
 * @param string           $method Method name.
 * @param array<int,mixed> $args   Arguments.
 * @return mixed
 */
function call_private( $method, array $args ) {
	$reflected = new ReflectionMethod( 'HOC_Hooks', $method );
	$reflected->setAccessible( true );
	return $reflected->invokeArgs( new HOC_Hooks(), $args );
}

/**
 * @param mixed               $value     Filtered value.
 * @param array<string,mixed> $transform Transform.
 * @return mixed
 */
function transform( $value, array $transform ) {
	return call_private( 'apply_transform', array( $value, $transform ) );
}

/**
 * @param mixed $value Hook argument.
 * @return mixed
 */
function reduce( $value ) {
	return call_private( 'reduce_arg', array( $value ) );
}

echo "FilterTransform\n";

ok(
	'append concatenates after the value',
	'Hello world' === transform( 'Hello', array( 'kind' => 'FILTER_TRANSFORM_KIND_APPEND', 'text' => ' world' ) )
);
ok(
	'prepend concatenates before the value',
	'Hi Bob' === transform( 'Bob', array( 'kind' => 'FILTER_TRANSFORM_KIND_PREPEND', 'text' => 'Hi ' ) )
);
ok(
	'const discards the value entirely',
	'fixed' === transform( 'anything', array( 'kind' => 'FILTER_TRANSFORM_KIND_CONST', 'text' => 'fixed' ) )
);
ok(
	'replace applies every pair',
	'a-b-c' === transform(
		'a b c',
		array( 'kind' => 'FILTER_TRANSFORM_KIND_REPLACE', 'replacements' => array( ' ' => '-' ) )
	)
);
ok(
	'replace with an empty search string is skipped, not infinite',
	'unchanged' === transform(
		'unchanged',
		array( 'kind' => 'FILTER_TRANSFORM_KIND_REPLACE', 'replacements' => array( '' => 'x' ) )
	)
);
ok(
	'replace treats the search as a literal, never a regex',
	'kept .* here' === transform(
		'kept .* here',
		array( 'kind' => 'FILTER_TRANSFORM_KIND_REPLACE', 'replacements' => array( '.+' => 'BOOM' ) )
	)
);

// The important negative cases: a filter must return SOMETHING sane for every input WordPress
// can hand it, because the page is blocked on the result.
$array_value = array( 'post-1', 'post-2' );
ok(
	'a non-string value passes through untouched',
	$array_value === transform( $array_value, array( 'kind' => 'FILTER_TRANSFORM_KIND_APPEND', 'text' => 'x' ) )
);
ok(
	'null passes through untouched',
	null === transform( null, array( 'kind' => 'FILTER_TRANSFORM_KIND_CONST', 'text' => 'x' ) )
);
$object_value = new stdClass();
ok(
	'an object passes through by identity',
	$object_value === transform( $object_value, array( 'kind' => 'FILTER_TRANSFORM_KIND_APPEND', 'text' => 'x' ) )
);
ok(
	'an unknown transform kind returns the value unchanged',
	'original' === transform( 'original', array( 'kind' => 'FILTER_TRANSFORM_KIND_SOMETHING_NEW', 'text' => 'x' ) )
);
ok(
	'an empty transform returns the value unchanged',
	'original' === transform( 'original', array() )
);
ok(
	'a missing text field degrades to a no-op append, not a fatal',
	'original' === transform( 'original', array( 'kind' => 'FILTER_TRANSFORM_KIND_APPEND' ) )
);

echo "\nHook argument reduction\n";

ok( 'an int survives as an int', 42 === reduce( 42 ) );
ok( 'a bool survives as a bool', false === reduce( false ) );
ok( 'null survives as null', null === reduce( null ) );
ok( 'a short string survives verbatim', 'post-slug' === reduce( 'post-slug' ) );

$long = str_repeat( 'x', HOC_Hooks::MAX_ARG_CHARS + 500 );
$clamped = reduce( $long );
ok(
	'an over-long string is clamped',
	is_string( $clamped ) && strlen( $clamped ) < strlen( $long ) && str_ends_with( $clamped, '...[truncated]' )
);

// This is the one that matters: WordPress passes whole objects to actions all the time.
class HOC_Fake_Post {
	public $post_content = 'secret customer content';
	public $user_pass    = 'hashed-password';
}
$reduced_object = reduce( new HOC_Fake_Post() );
ok(
	'an object is reduced to its class name only',
	'[object HOC_Fake_Post]' === $reduced_object
);
ok(
	'no object property leaks into the reduced value',
	is_string( $reduced_object )
		&& false === strpos( $reduced_object, 'secret customer content' )
		&& false === strpos( $reduced_object, 'hashed-password' )
);
ok(
	'an array is reduced to its type name only',
	'[array]' === reduce( array( 'sensitive' => 'value' ) )
);

echo "\nRefused hooks\n";

ok(
	'bootstrap hooks that would make a site unbootable are refused',
	in_array( 'plugins_loaded', HOC_Hooks::REFUSED_HOOKS, true )
		&& in_array( 'init', HOC_Hooks::REFUSED_HOOKS, true )
		&& in_array( 'all', HOC_Hooks::REFUSED_HOOKS, true )
);

echo "\n";
if ( $failed > 0 ) {
	echo "FAILED: $failed of $tests\n";
	exit( 1 );
}
echo "All $tests tests passed.\n";
exit( 0 );
