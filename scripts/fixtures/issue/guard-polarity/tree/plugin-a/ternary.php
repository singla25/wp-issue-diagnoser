<?php
$r = function_exists( 'eregi_replace' ) ? eregi_replace( 'a', 'b', $a ) : null;
$s = ! function_exists( 'eregi_replace' ) ? null : eregi_replace( 'a', 'b', $a );
if ( function_exists( 'eregi_replace' ) && eregi_replace( 'a', 'b', $a ) ) {
	$x = 1;
}
